//! Running local commands on the user's behalf.
//!
//! A Blob reads untrusted text every turn — fetched pages, search results,
//! tool output from a connected inbox — and any of it can contain "run this".
//! So the shape of this surface matters more than its convenience:
//!
//! - **argv, never a shell string.** Nothing here goes through `sh -c`, so
//!   there is no place for `;`, backticks, `$(…)` or a pipe to be *parsed*.
//!   They can only ever arrive as literal characters in one argument.
//! - **Default-deny allowlist, not a blocklist.** A blocklist is a list of the
//!   attacks someone already thought of; `rm` is not more dangerous than a
//!   Python one-liner. Only named programs run.
//! - **Confirmation is the caller's job.** Anything off the list is refused
//!   here, and the UI layer asks the user before extending it — the decision
//!   belongs to a human, not to whatever text the model just read.
//! - **Deadline and output cap**, because a hung or chatty command otherwise
//!   pins a turn or floods the context window.
//!
//! This is deliberately not a terminal. Integrations do not need one: the
//! Composio meta-tools reach every connected app without it.

use crate::error::{Error, Result};
use serde::Serialize;
use std::process::Command;

/// Programs a Blob may run without asking.
///
/// Each entry must be unable to execute anything else — otherwise it is a
/// shell wearing another name and the rest of this module is theatre. That
/// rules out the obvious interpreters (`sh`, `python`, `node`, `osascript`)
/// and two that look harmless until you read their flags:
///
/// - **`find`** has `-exec`/`-execdir`: `find . -exec sh -c … \;` is arbitrary
///   execution with no shell involved. `rg --files` covers the real use.
/// - **`git`** has `-c`: `git -c alias.x='!sh -c …' x` runs a shell, as does a
///   repo-supplied hook or pager. A Blob is a personal assistant, not a
///   coding agent; it has no need for it.
///
/// Everything left reads bytes and prints them. Extending this list means
/// re-asking the same question, and a `--help` page is the place to check.
const ALLOWED: [&str; 8] = [
    "composio", // the connected-apps surface
    "ls", "cat", "head", "tail", "wc", "grep", "rg",
];

/// Ceiling on one command. Long enough for a slow network call, short enough
/// that a wedged process cannot hold a turn open.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Cap on captured output: this text lands in the model's context.
const OUTPUT_LIMIT: usize = 40_000;

/// Whether this call may run at all. Split out so the gate is unit-testable
/// without spawning anything.
fn check_call(program: &str, args: &[String]) -> Result<()> {
    if !ALLOWED.contains(&program) {
        return Err(Error::Io(format!(
            "`{program}` is not on the allowed list. Allowed: {}.",
            ALLOWED.join(", ")
        )));
    }
    // A cap on count as well as content: argv is not a place to smuggle a
    // megabyte, and no legitimate call needs this many.
    if args.len() > 64 || args.iter().any(|arg| arg.len() > 4_096) {
        return Err(Error::Io("Too many or too-long arguments.".into()));
    }
    Ok(())
}

/// What a command produced.
#[derive(Serialize)]
pub(crate) struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    /// `None` when the process was killed at the deadline.
    pub code: Option<i32>,
}

/// The programs a Blob may run, for the UI to show.
#[tauri::command]
pub(crate) fn shell_allowed() -> Vec<String> {
    ALLOWED.iter().map(|name| (*name).to_owned()).collect()
}

/// Run one allowlisted program with literal arguments.
///
/// `program` is matched exactly against the allowlist — not a path, not a
/// prefix — so `./composio` or `/tmp/git` cannot stand in for the real one.
/// Resolution is left to `PATH`, the same lookup a user gets.
#[tauri::command]
pub(crate) async fn shell_run(program: String, args: Vec<String>) -> Result<CommandOutput> {
    check_call(&program, &args)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new(&program)
            .args(&args)
            // No inherited stdin: a command that decides to prompt must fail
            // rather than block a turn forever waiting for a human.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| Error::Io(format!("Could not run `{program}`: {error}")))?;

        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();

        let started = std::time::Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(error) => return Err(Error::Io(error.to_string())),
            }
            if started.elapsed() >= TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };

        // Read after exit: safe only because both streams are capped and the
        // deadline above bounds how long a filled pipe can stall the child.
        let mut out = String::new();
        if let Some(handle) = stdout.as_mut() {
            let _ = std::io::Read::read_to_string(handle, &mut out);
        }
        let mut err = String::new();
        if let Some(handle) = stderr.as_mut() {
            let _ = std::io::Read::read_to_string(handle, &mut err);
        }

        Ok(CommandOutput {
            stdout: out.chars().take(OUTPUT_LIMIT).collect(),
            stderr: err.chars().take(OUTPUT_LIMIT).collect(),
            code: status.and_then(|status| status.code()),
        })
    })
    .await
    .map_err(|error| Error::Io(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_that_can_execute_something_else_is_allowed() {
        // The allowlist is only meaningful while no entry can run arbitrary
        // code. Beyond the obvious interpreters, two everyday tools qualify:
        // `find -exec` spawns commands directly, and `git -c alias.x='!sh'`
        // (plus hooks and pagers) reaches a shell from a repo the user did not
        // write. Both were on this list until this test was written.
        for program in [
            "sh",
            "bash",
            "zsh",
            "python",
            "python3",
            "node",
            "perl",
            "ruby",
            "osascript",
            "env",
            "xargs",
            "sudo",
            "find",
            "git",
            "awk",
            "sed",
            "ssh",
            "make",
            "npm",
        ] {
            assert!(
                !ALLOWED.contains(&program),
                "`{program}` can execute arbitrary code and must not be allowlisted"
            );
        }
    }

    #[test]
    fn a_program_off_the_list_is_refused_before_it_runs() {
        // Including paths that dress up an allowed name: matching is exact, so
        // a planted binary cannot stand in for the real one.
        for program in [
            "curl",
            "./composio",
            "/tmp/composio",
            "COMPOSIO",
            "",
            "ls;cat",
        ] {
            assert!(
                check_call(program, &[]).is_err(),
                "`{program}` must be refused"
            );
        }
        assert!(check_call("composio", &["connections".to_owned()]).is_ok());
    }

    #[test]
    fn shell_metacharacters_are_just_argument_text() {
        // The gate does not scrub these, and must not: with argv there is no
        // shell to parse them, so they reach the program as one literal name.
        // Scrubbing would imply a shell exists and invite `sh -c` later.
        let payload = "hello; rm -rf /tmp/x && echo pwned `whoami` $(id)".to_owned();
        assert!(check_call("ls", std::slice::from_ref(&payload)).is_ok());

        // Size is bounded, though: argv is not a smuggling channel.
        assert!(check_call("ls", &["x".repeat(5_000)]).is_err());
        assert!(check_call("ls", &vec!["x".to_owned(); 100]).is_err());
    }
}
