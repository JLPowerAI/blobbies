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
//! - **Default-deny on *options*, not only on program names.** A program that
//!   cannot execute anything else still has flags that can: `rg --pre=sh`,
//!   `rg --hostname-bin=sh` and `rg -z` all hand a program name to ripgrep,
//!   which runs it. Allowlisting the binary while passing its argv through
//!   untouched is a shell with extra steps. Each reader therefore declares the
//!   flags it accepts, and anything unlisted is refused.
//! - **The same sandbox as the file tools.** Positional arguments are paths,
//!   and every one is resolved through `home::resolve_in_home` against this
//!   Blob's home folder. Without that, `cat` reads any file the user can —
//!   SSH keys, `.env` files — straight into a model context that has
//!   `web_fetch` in the same turn.
//! - **Deadline and output cap**, because a hung or chatty command otherwise
//!   pins a turn or floods the context window.
//!
//! **Nothing here asks the user first, and that is a decision, not an
//! oversight.** A prompt on every `cat` would be answered reflexively within a
//! day, which buys nothing and trains the habit of clicking through. So the
//! rules above are the entire boundary: there is no human in the loop to catch
//! what they let past, including on scheduled routines that run unattended.
//!
//! That has a direct consequence for anyone editing this file. `ALLOWED` is a
//! compile-time constant — neither the model nor the UI can widen it at
//! runtime — so adding an entry is a decision taken once, on behalf of every
//! user, with no confirmation step downstream to soften it. Before adding a
//! program, assume its argv is chosen by a hostile web page, and read its
//! flags with that in mind: `rg` sat here with `--pre` reachable, which made
//! the allowlist decorative until the option gate above was written.
//!
//! What remains reachable, with all of it holding: an injected instruction can
//! read this Blob's own files and put them in a context that also has
//! `web_fetch`. Containment bounds that to one Blob's home; it does not
//! eliminate it.
//!
//! This is deliberately not a terminal. Integrations do not need one: the
//! Composio meta-tools reach every connected app without it.

use std::path::Path;

use crate::error::{Error, Result};
use serde::Serialize;
use std::process::Command;

/// How a program's arguments are read, and therefore how they are checked.
enum Shape {
    /// Arguments carry no filesystem meaning, so there is nothing to contain.
    ///
    /// Only `composio`, whose arguments are tool names and JSON payloads. Its
    /// own surface is gated in `composio.rs`; forcing the reader rules onto it
    /// would break every `--account`/`-d` call without closing anything, since
    /// it names no paths. The credential-directory check below still applies.
    Opaque,
    /// A program that reads files: flags allowlisted, positionals contained.
    Reader {
        /// Leading positionals that are *not* paths — `grep`/`rg` take a
        /// PATTERN first. `-e/--regexp` is deliberately unlisted so the
        /// pattern is always positional and this count stays truthful.
        patterns: usize,
        /// Single-letter flags, clustered (`-la`) or with an attached value
        /// (`-n50`, `-A3`). ASCII digits are always accepted inside a cluster:
        /// they can only ever be a count. Value-taking flags must use the
        /// attached form — a detached `-n 50` would leave `50` looking like a
        /// positional path.
        short: &'static str,
        /// Long flags by name; `--name=value` is matched on the name only.
        long: &'static [&'static str],
    },
}

struct Program {
    name: &'static str,
    shape: Shape,
}

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
/// "Cannot execute anything else" is a claim about a program *and its argv*,
/// which is why each reader carries its own flag list. `rg` was on this list
/// with `--pre` reachable: a program allowlist alone did not hold.
const ALLOWED: [Program; 8] = [
    Program {
        name: "composio",
        shape: Shape::Opaque,
    },
    Program {
        name: "ls",
        shape: Shape::Reader {
            patterns: 0,
            short: "1aAhlrRSt",
            long: &["all", "human-readable", "recursive", "reverse"],
        },
    },
    Program {
        name: "cat",
        shape: Shape::Reader {
            patterns: 0,
            short: "bns",
            long: &["number", "number-nonblank", "squeeze-blank"],
        },
    },
    Program {
        // No `f`/`--follow`: it never returns, so it only ever buys a wedged
        // turn and a 120s wait for the deadline below.
        name: "head",
        shape: Shape::Reader {
            patterns: 0,
            short: "cnqv",
            long: &["bytes", "lines", "quiet", "silent", "verbose"],
        },
    },
    Program {
        name: "tail",
        shape: Shape::Reader {
            patterns: 0,
            short: "cnqv",
            long: &["bytes", "lines", "quiet", "silent", "verbose"],
        },
    },
    Program {
        name: "wc",
        shape: Shape::Reader {
            patterns: 0,
            short: "clmw",
            long: &["bytes", "chars", "lines", "words"],
        },
    },
    Program {
        // No `-f`/`--file`: it reads the pattern list from a path, which would
        // need containing too. No `-e`: it moves the pattern off the
        // positional list that `patterns` counts.
        name: "grep",
        shape: Shape::Reader {
            patterns: 1,
            short: "ABCEFHILchilmnorRsvwx",
            long: &[
                "after-context",
                "before-context",
                "context",
                "count",
                "exclude",
                "extended-regexp",
                "files-with-matches",
                "files-without-match",
                "fixed-strings",
                "ignore-case",
                "include",
                "invert-match",
                "line-number",
                "line-regexp",
                "max-count",
                "no-filename",
                "only-matching",
                "quiet",
                "recursive",
                "silent",
                "with-filename",
                "word-regexp",
            ],
        },
    },
    Program {
        // The dangerous three stay off both lists and are covered by a test:
        // `--pre`/`--pre-glob` filter each file through a command, and
        // `--hostname-bin` runs one outright. `-z`/`--search-zip` spawns a
        // decompressor, which is the same hole wearing a friendlier name.
        // `-g`/`-t`/`-e`/`-f` take detached values that would read as
        // positional paths, so they are omitted too.
        //
        // Two more are absent because ripgrep spells them unlike `grep`, and
        // carrying grep's meanings across reopens the containment hole this
        // module exists to close:
        //
        // - **`-L`** here is `--follow`, not grep's `--files-without-match`.
        //   It follows symlinks while walking, so one link inside a Blob's
        //   home reads whatever it points at outside.
        // - **`--files`** takes no pattern, which makes the first positional
        //   a *path* — and the `patterns: 1` skip below would wave exactly
        //   that argument through unchecked, turning this into a lister for
        //   any directory on the machine. `ls` already lists, inside the home.
        name: "rg",
        shape: Shape::Reader {
            patterns: 1,
            short: "ABCFHINScilmnovwx",
            long: &[
                "after-context",
                "before-context",
                "case-sensitive",
                "column",
                "context",
                "count",
                "count-matches",
                "files-with-matches",
                "files-without-match",
                "fixed-strings",
                "hidden",
                "ignore-case",
                "invert-match",
                "line-number",
                "max-count",
                "no-filename",
                "no-ignore",
                "no-line-number",
                "only-matching",
                "smart-case",
                "sort",
                "stats",
                "with-filename",
                "word-regexp",
            ],
        },
    },
];

/// Ceiling on one command. Long enough for a slow network call, short enough
/// that a wedged process cannot hold a turn open.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Any argument naming the Composio CLI's credential directory is refused.
///
/// `~/.composio/config.json` holds the connected-apps credential, written by
/// `composio login`. Commands reach connected apps through the `composio`
/// program itself, so no other program has legitimate business naming this
/// directory — and one direct hit would put the credential in the model's
/// context, one `web_fetch` from leaving the machine.
///
/// Home containment already puts this directory out of reach of every reader.
/// This check is what covers `composio` itself, which takes no path
/// containment, and it is kept for the readers as a second wall: matching is
/// case-insensitive for macOS, whose default filesystem is too.
const PROTECTED_DIR_NAME: &str = ".composio";

/// Cap on captured output: this text lands in the model's context.
const OUTPUT_LIMIT: usize = 40_000;

fn find_program(name: &str) -> Option<&'static Program> {
    ALLOWED.iter().find(|program| program.name == name)
}

/// Whether one flag is on this program's list.
///
/// Long flags match on the name before `=`, so `--max-count=5` is judged as
/// `max-count`. Short flags are checked per character, because they cluster
/// (`-la`) and carry attached numeric values (`-A3`).
fn check_flag(program: &str, arg: &str, short: &str, long: &[&str]) -> Result<()> {
    let refuse = || {
        Err(Error::Io(format!(
            "`{arg}` is not an allowed option for `{program}`. Only plain \
             reading and matching options are permitted — nothing that runs \
             another program, loads a config, or reads a list from a file."
        )))
    };

    if let Some(body) = arg.strip_prefix("--") {
        let name = body.split('=').next().unwrap_or(body);
        return if long.contains(&name) {
            Ok(())
        } else {
            refuse()
        };
    }

    let Some(body) = arg.strip_prefix('-') else {
        return Ok(());
    };
    for character in body.chars() {
        if !character.is_ascii_digit() && !short.contains(character) {
            return refuse();
        }
    }
    Ok(())
}

/// Whether one positional argument names a file inside this Blob's home.
///
/// Delegates to the file tools' own resolver, so `..`, absolute paths and
/// symlinks out of the sandbox are rejected by exactly the rule that governs
/// `read_file`. A leading `./` is stripped first (`rg pattern ./notes` is the
/// natural spelling, and `Component::CurDir` would otherwise be refused), and
/// the home directory itself is allowed — it is already the working directory.
fn check_path(home: &Path, arg: &str) -> Result<()> {
    let trimmed = arg.trim_start_matches("./");
    if trimmed.is_empty() || trimmed == "." {
        return Ok(());
    }
    // `~` is a shell's expansion, and there is no shell here: a leading `~`
    // would be a literal directory name inside the home folder, so it is
    // already contained. It is refused anyway because it is never what the
    // caller meant — saying so beats an unexplained "no such file" that
    // invites a retry with a spelling that also cannot work.
    if trimmed == "~" || trimmed.starts_with("~/") {
        return Err(Error::PathOutsideHome);
    }
    crate::home::resolve_in_home(home, trimmed).map(|_| ())
}

/// Whether this call may run at all. Split out so the gate is unit-testable
/// without spawning anything.
///
/// `home` is this Blob's home folder, or `None` when the caller has no
/// sandbox to offer — in which case file-reading programs are refused outright
/// rather than falling back to the whole filesystem.
fn check_call(program: &str, args: &[String], home: Option<&Path>) -> Result<()> {
    let Some(entry) = find_program(program) else {
        return Err(Error::Io(format!(
            "`{program}` is not on the allowed list. Allowed: {}.",
            ALLOWED
                .iter()
                .map(|allowed| allowed.name)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    };
    // A cap on count as well as content: argv is not a place to smuggle a
    // megabyte, and no legitimate call needs this many.
    if args.len() > 64 || args.iter().any(|arg| arg.len() > 4_096) {
        return Err(Error::Io("Too many or too-long arguments.".into()));
    }
    if args
        .iter()
        .any(|arg| arg.to_ascii_lowercase().contains(PROTECTED_DIR_NAME))
    {
        return Err(Error::Io(
            "That path holds the connected-apps credential and is off-limits to \
             commands. Reach connected apps through the app_* tools instead."
                .into(),
        ));
    }

    let Shape::Reader {
        patterns,
        short,
        long,
    } = entry.shape
    else {
        return Ok(());
    };
    let Some(home) = home else {
        return Err(Error::Io(format!(
            "`{program}` reads files, and this Blob has no home folder to read \
             from."
        )));
    };

    let mut end_of_flags = false;
    let mut positional = 0usize;
    for arg in args {
        if !end_of_flags && arg.len() > 1 && arg.starts_with('-') {
            if arg == "--" {
                end_of_flags = true;
                continue;
            }
            check_flag(program, arg, short, long)?;
            continue;
        }
        positional += 1;
        // The leading PATTERN of a `grep`/`rg` call is a regex, not a path.
        if positional <= patterns {
            continue;
        }
        check_path(home, arg)?;
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
    ALLOWED
        .iter()
        .map(|program| program.name.to_owned())
        .collect()
}

/// Run one allowlisted program with literal arguments, inside `id`'s home.
///
/// `program` is matched exactly against the allowlist — not a path, not a
/// prefix — so `./composio` or `/tmp/git` cannot stand in for the real one.
/// Resolution is left to `PATH`, the same lookup a user gets.
#[tauri::command]
pub(crate) async fn shell_run(
    app: tauri::AppHandle,
    id: Option<String>,
    program: String,
    args: Vec<String>,
) -> Result<CommandOutput> {
    let home = match id {
        Some(id) => Some(crate::home::home_root(
            &crate::store::data_root(&app)?,
            &id,
        )?),
        None => None,
    };
    check_call(&program, &args, home.as_deref())?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(&program);
        command.args(&args);
        if let Some(home) = home.as_deref() {
            // Relative paths then resolve inside the sandbox that `check_call`
            // just measured them against, instead of wherever the app happens
            // to have been launched from.
            command.current_dir(home);
        }
        if program == "rg" {
            // `RIPGREP_CONFIG_PATH` names a file of default arguments, and
            // `--pre` in that file would reach ripgrep behind the flag gate
            // above. Nothing here needs a user config.
            command.env_remove("RIPGREP_CONFIG_PATH");
        }
        let mut child = command
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
    use std::path::PathBuf;
    use std::time::UNIX_EPOCH;

    /// A real directory, because containment canonicalizes both sides.
    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("blobbies-shell-tests")
            .join(format!(
                "{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or_default()
            ));
        std::fs::create_dir_all(&dir).unwrap_or_else(|_| panic!("temp home"));
        dir
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

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
                find_program(program).is_none(),
                "`{program}` can execute arbitrary code and must not be allowlisted"
            );
        }
    }

    #[test]
    fn a_program_off_the_list_is_refused_before_it_runs() {
        // Including paths that dress up an allowed name: matching is exact, so
        // a planted binary cannot stand in for the real one.
        let home = temp_home("off-list");
        for program in [
            "curl",
            "./composio",
            "/tmp/composio",
            "COMPOSIO",
            "",
            "ls;cat",
        ] {
            assert!(
                check_call(program, &[], Some(&home)).is_err(),
                "`{program}` must be refused"
            );
        }
        assert!(check_call("composio", &args(&["connections"]), Some(&home)).is_ok());
    }

    #[test]
    fn ripgrep_options_that_run_another_program_are_refused() {
        // The bypass this gate exists for. Each of these hands a program name
        // to ripgrep, which runs it — so an allowlist of *binaries* alone let
        // any binary on PATH through, with untrusted page text choosing it.
        let home = temp_home("rg-exec");
        for flag in [
            "--pre=/bin/sh",
            "--pre",
            "--pre-glob=*",
            "--hostname-bin=/bin/sh",
            "--hostname-bin",
            "--search-zip",
            "-z",
            // Clustered, so a per-character check is what catches it.
            "-iz",
            // Reads arguments from a file, including the three above.
            "--file=/tmp/patterns",
            "-f",
        ] {
            assert!(
                check_call("rg", &args(&[flag, "TODO"]), Some(&home)).is_err(),
                "`rg {flag}` must be refused"
            );
        }
        // The same class on the other reader, in case its list ever grows.
        assert!(check_call("grep", &args(&["--pre=/bin/sh", "TODO"]), Some(&home)).is_err());
    }

    #[test]
    fn ripgrep_options_that_escape_the_home_folder_are_refused() {
        // Both of these read like harmless `grep` spellings and are not:
        //
        // - `-L` is ripgrep's `--follow`, so it walks symlinks out of the home
        //   folder (in `grep` the same letter means `--files-without-match`).
        // - `--files` takes no pattern, so its first positional is a path — the
        //   one argument `patterns: 1` deliberately does not path-check.
        //
        // Neither hands a program to anything, so the exec test above cannot
        // catch them; they defeat containment instead of the allowlist.
        let home = temp_home("rg-escape");
        for flag in ["-L", "-iL", "--follow", "--files"] {
            assert!(
                check_call("rg", &args(&[flag, "TODO"]), Some(&home)).is_err(),
                "`rg {flag}` must be refused"
            );
        }
        // `-l` (lowercase) is `--files-with-matches` and stays allowed: it
        // names matching files inside the sandbox and follows nothing.
        assert!(check_call("rg", &args(&["-l", "TODO"]), Some(&home)).is_ok());
    }

    #[test]
    fn unlisted_options_are_refused_by_default() {
        // Default-deny is the property under test: the gate must refuse a flag
        // it has never heard of, not just the ones already known to be bad.
        let home = temp_home("default-deny");
        for (program, flag) in [
            ("rg", "--some-future-flag"),
            ("rg", "-Q"),
            ("ls", "--colour-me-surprised"),
            ("cat", "-Z"),
            ("head", "--follow"),
            ("tail", "-f"),
        ] {
            assert!(
                check_call(program, &args(&[flag]), Some(&home)).is_err(),
                "`{program} {flag}` must be refused"
            );
        }
        // Ordinary reading still works, including clustered short flags and
        // the attached numeric form the detached one would break.
        for (program, call) in [
            ("ls", args(&["-la"])),
            ("cat", args(&["-n", "notes.md"])),
            ("head", args(&["-n50", "notes.md"])),
            ("wc", args(&["-l", "notes.md"])),
            ("grep", args(&["-in", "TODO", "notes.md"])),
            ("grep", args(&["-A3", "TODO", "notes.md"])),
            ("rg", args(&["--ignore-case", "TODO", "notes"])),
            ("rg", args(&["-n", "TODO", "./notes"])),
            ("rg", args(&["--max-count=5", "TODO", "."])),
        ] {
            assert!(
                check_call(program, &call, Some(&home)).is_ok(),
                "`{program} {call:?}` must be allowed"
            );
        }
    }

    #[test]
    fn paths_outside_the_home_folder_are_refused() {
        // Same rule as the file tools: `cat` must not out-reach `read_file`.
        // Without this, any file the user can read reaches the model context,
        // which has web_fetch in the same turn.
        let home = temp_home("containment");
        for path in [
            "../outside.txt",
            "../../outside.txt",
            "notes/../../outside.txt",
            "/etc/passwd",
            "/Users/ken/.ssh/id_rsa",
            "~/.ssh/id_rsa",
        ] {
            assert!(
                check_call("cat", &args(&[path]), Some(&home)).is_err(),
                "`cat {path}` must be refused"
            );
            // The pattern slot must not become the way around it: only the
            // FIRST positional is a pattern, every later one is a path.
            assert!(
                check_call("rg", &args(&["TODO", path]), Some(&home)).is_err(),
                "`rg TODO {path}` must be refused"
            );
        }
        // Inside the sandbox, all the ordinary spellings still work.
        for path in ["notes.md", "./notes.md", "notes/today.md", ".", "./"] {
            assert!(
                check_call("cat", &args(&[path]), Some(&home)).is_ok(),
                "`cat {path}` must be allowed"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_home_folder_is_refused() {
        // `resolve_in_home` canonicalizes, so a planted link is judged by
        // where it points, not by how the argument is spelled.
        let home = temp_home("symlink");
        std::os::unix::fs::symlink("/etc", home.join("escape"))
            .unwrap_or_else(|_| panic!("symlink"));
        assert!(check_call("cat", &args(&["escape/passwd"]), Some(&home)).is_err());
    }

    #[test]
    fn a_file_command_without_a_home_folder_is_refused() {
        // Fail closed: no sandbox means no reading, never "read anywhere".
        for program in ["ls", "cat", "head", "tail", "wc", "grep", "rg"] {
            assert!(
                check_call(program, &args(&["notes.md"]), None).is_err(),
                "`{program}` must be refused without a home"
            );
        }
        // `composio` names no paths, so it is unaffected either way.
        assert!(check_call("composio", &args(&["connections"]), None).is_ok());
    }

    #[test]
    fn shell_metacharacters_are_just_argument_text() {
        // The gate does not scrub these, and must not: with argv there is no
        // shell to parse them, so they reach the program as one literal name.
        // Scrubbing would imply a shell exists and invite `sh -c` later.
        let home = temp_home("metacharacters");
        let payload = "hello; rm -rf tmp/x && echo pwned `whoami` $(id)".to_owned();
        assert!(check_call("ls", std::slice::from_ref(&payload), Some(&home)).is_ok());

        // Size is bounded, though: argv is not a smuggling channel.
        assert!(check_call("ls", &["x".repeat(5_000)], Some(&home)).is_err());
        assert!(check_call("ls", &vec!["x".to_owned(); 100], Some(&home)).is_err());
    }

    #[test]
    fn the_composio_credential_directory_is_out_of_bounds() {
        // Every spelling that can actually resolve into ~/.composio carries
        // the directory name literally (no shell means no ~ or $HOME
        // expansion), so each of these must be refused before anything runs.
        // Containment refuses them a second time for the readers; this check
        // is what covers `composio` itself, which takes no path containment.
        let home = temp_home("credential");
        for arg in [
            "/Users/ken/.composio/config.json",
            "~/.composio/config.json",
            ".Composio/config.json", // macOS filesystems are case-insensitive
            "/Users/ken/.composio",
            "--config=/Users/ken/.composio/config.json",
        ] {
            assert!(
                check_call("cat", &args(&[arg]), Some(&home)).is_err(),
                "must refuse {arg:?}"
            );
            assert!(
                check_call("composio", &args(&[arg]), Some(&home)).is_err(),
                "must refuse {arg:?} for composio too"
            );
        }
        // Neighbouring names and ordinary text stay available: the check is
        // narrow enough that a false refusal on a real command would be a bug.
        assert!(check_call("cat", &args(&["notes/.compositor.md"]), Some(&home)).is_ok());
        assert!(check_call("ls", &args(&[".compositorc-example"]), Some(&home)).is_ok());
        assert!(check_call("composio", &args(&["connections"]), Some(&home)).is_ok());
    }
}
