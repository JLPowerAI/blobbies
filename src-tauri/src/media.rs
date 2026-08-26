//! Reading and cutting local media with ffmpeg.
//!
//! **Why this is not on the shell allowlist.** `shell.rs` runs a fixed set of
//! read-only programs and gates their flags, because a program that cannot
//! execute anything else still has options that can. `ffmpeg` is the extreme
//! case of that: its own argv reaches network protocols (`http:`, `tcp:`,
//! `concat:`), arbitrary demuxers, and a filter graph that reads and writes
//! files of its own accord. Allowlisting the binary and passing a
//! model-chosen argv through would be a hole no flag list could close. So the
//! argv is never supplied — it is *built here*, from typed parameters, the way
//! `capture.rs` builds its work from a window id.
//!
//! What holds the surface shut, on every call:
//!
//! - **argv, never a shell string**, so no separator is ever parsed.
//! - **`-protocol_whitelist file`** with `-f` never set from input: the input
//!   is a local file or the call fails. A playlist or `concat` demuxer cannot
//!   reach out over the network on ffmpeg's own initiative.
//! - **Every path through `home::resolve_in_home`**, input and output alike —
//!   the same sandbox as the file tools. Reading `~/.ssh/id_rsa` as "media"
//!   would otherwise put it in a context that also has `web_fetch`.
//! - **`-nostdin`**, so a prompt fails instead of pinning a turn forever.
//! - **A deadline**, an **output size cap**, and **one job at a time**: ffmpeg
//!   is a transcoder, and an unbounded one starves the machine the user is
//!   working on.
//!
//! The residual risk is stated plainly: ffmpeg is a very large parser surface
//! and the file it parses may have been downloaded by whoever the Blob was
//! talking to. Containment bounds a compromise to this Blob's home folder and
//! one process at a time; it does not eliminate the parser.

use crate::error::{Error, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Longest one media job may run. Long enough for a real clip off a long
/// recording, short enough that a pathological input cannot hold a core.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Cap on what an output may grow to, checked as it is written. A filter that
/// expands its input has no natural limit; the home budget is not enough on
/// its own because it is only checked between writes.
const MAX_OUTPUT_BYTES: u64 = 512 * 1024 * 1024;

/// Cap on ffprobe's report, which is bounded in practice but not in principle.
const MAX_REPORT_CHARS: usize = 8_000;

/// Longest a time offset string may be. `HH:MM:SS.mmm` and change.
const MAX_TIME_CHARS: usize = 16;

/// One job at a time, process-wide.
///
/// simplification: a global lock, so two Blobs asking at once queue rather
/// than run in parallel. ffmpeg saturates every core it is given, and the user
/// is working on this machine. Upgrade path: a semaphore sized to a fraction
/// of the core count, if anyone ever has two media Blobs at once.
static JOB: Mutex<()> = Mutex::new(());

/// What ffprobe found, as the model sees it.
#[derive(Serialize)]
pub(crate) struct MediaInfo {
    pub report: String,
}

/// Where a produced file landed.
#[derive(Serialize)]
pub(crate) struct MediaOutput {
    /// Home-relative name, so the Blob can hand it to its own file tools.
    pub name: String,
    pub bytes: u64,
}

/// Is ffmpeg installed? Drives whether the tools are offered at all.
///
/// Both binaries, because a build with one and not the other would offer
/// `media_clip` and fail every `media_info`.
#[tauri::command]
pub(crate) fn ffmpeg_present() -> bool {
    ["ffmpeg", "ffprobe"]
        .iter()
        .all(|program| which(program).is_some())
}

/// Locate a program on PATH without a shell.
///
/// `which(1)` is itself a program to run; splitting PATH is three lines and
/// has no argv of its own to get wrong.
fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

/// Validate a time offset supplied by a model.
///
/// ffmpeg's time syntax is `[HH:]MM:SS[.m...]` or plain seconds. Anything else
/// is refused rather than passed through: a value starting with `-` would be
/// read as a *flag*, which is how a fixed argv turns back into an open one.
fn check_time(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_TIME_CHARS {
        return Err(Error::InputTooLong {
            max: MAX_TIME_CHARS,
        });
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_digit() || character == ':' || character == '.')
    {
        return Err(Error::EmptyInput);
    }
    Ok(())
}

/// Resolve both ends of a job inside one Blob's home.
///
/// The output must not exist: overwriting is why `-y` is never passed, and
/// checking here means the refusal is ours, with a name in it, rather than
/// ffmpeg's silent clobber or an interactive prompt on a `-nostdin` process.
fn resolve_pair(home: &Path, input: &str, output: &str) -> Result<(PathBuf, PathBuf)> {
    let source = crate::home::resolve_in_home(home, input)?;
    if !source.is_file() {
        return Err(Error::FileNotFound);
    }
    let target = crate::home::resolve_in_home(home, output)?;
    if target.exists() {
        return Err(Error::PathOutsideHome);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| Error::Io(error.to_string()))?;
    }
    Ok((source, target))
}

/// Run one ffmpeg-family process to completion, under the deadline.
///
/// Returns stderr, which is where both tools write everything worth reading.
fn run(program: &str, args: &[String], watch: Option<&Path>) -> Result<String> {
    let binary = which(program).ok_or_else(|| {
        Error::Io(format!(
            "{program} isn't installed — install ffmpeg to use this"
        ))
    })?;
    // Held for the whole job: the point of the lock is that only one ffmpeg
    // runs, not that only one is started.
    let _slot = JOB.lock().map_err(|_| Error::Io("media is busy".into()))?;

    let mut child = Command::new(binary)
        .args(args)
        // A process that decides to prompt must fail, not block a turn.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| Error::Io(format!("Could not run {program}: {error}")))?;

    let started = Instant::now();
    let mut over_size = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(error) => return Err(Error::Io(error.to_string())),
        }
        // Checked while it runs, not after: an output that only stops growing
        // when the disk is full has already done the damage by then.
        if let Some(path) = watch
            && std::fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_OUTPUT_BYTES)
        {
            over_size = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        if started.elapsed() >= TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    let mut report = String::new();
    if let Some(mut handle) = child.stderr.take() {
        let _ = std::io::Read::read_to_string(&mut handle, &mut report);
    }
    let mut out = String::new();
    if let Some(mut handle) = child.stdout.take() {
        let _ = std::io::Read::read_to_string(&mut handle, &mut out);
    }

    match status {
        Some(status) if status.success() => Ok([out, report]
            .concat()
            .chars()
            .take(MAX_REPORT_CHARS)
            .collect()),
        // A killed job leaves a partial file behind; it must not look like a
        // result, so the caller's output is removed with it.
        None if over_size => {
            if let Some(path) = watch {
                let _ = std::fs::remove_file(path);
            }
            Err(Error::FileTooLarge)
        }
        None => {
            if let Some(path) = watch {
                let _ = std::fs::remove_file(path);
            }
            Err(Error::Io("that took too long and was stopped".into()))
        }
        Some(_) => {
            if let Some(path) = watch {
                let _ = std::fs::remove_file(path);
            }
            // ffmpeg's own last line names the real problem ("Invalid data
            // found…"), which is what a model needs to stop retrying.
            Err(Error::Io(
                report
                    .lines()
                    .rev()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or("that file couldn't be read as media")
                    .chars()
                    .take(200)
                    .collect(),
            ))
        }
    }
}

/// argv for `media_info`. Built here so a test can read it without a binary.
fn info_args(path: &Path) -> Vec<String> {
    // No `-nostdin` here, deliberately: ffprobe does not accept it and fails
    // the whole call with "Option not found". The guarantee comes from `run`,
    // which gives the process no stdin at all — stronger than the flag.
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        // The input is a local file or nothing. Without this, a crafted
        // playlist or `concat:` input reaches the network on ffprobe's own
        // initiative, from inside a turn that also has `web_fetch`.
        "-protocol_whitelist".into(),
        "file".into(),
        "-show_format".into(),
        "-show_streams".into(),
        "-of".into(),
        "default=noprint_wrappers=1".into(),
        // Everything after this is a value, never a flag, whatever it starts
        // with — the last defence if a path check were ever loosened.
        "-i".into(),
        path.to_string_lossy().into_owned(),
    ]
}

/// argv for `media_clip`: copy a time range without re-encoding.
fn clip_args(source: &Path, target: &Path, start: &str, duration: &str) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-protocol_whitelist".into(),
        "file".into(),
        "-ss".into(),
        start.into(),
        "-t".into(),
        duration.into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        // Stream copy: no filter graph, no encoder, and orders of magnitude
        // less work than a transcode.
        "-c".into(),
        "copy".into(),
        // No `-y`: the caller already refused an existing output, and a
        // clobber must never be ffmpeg's decision to make.
        target.to_string_lossy().into_owned(),
    ]
}

/// argv for `media_audio`: lift the audio track out as a WAV.
fn audio_args(source: &Path, target: &Path) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-protocol_whitelist".into(),
        "file".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        // Drop video explicitly rather than relying on the muxer to.
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        // 16k mono PCM: what every speech model wants, and it keeps a long
        // recording inside the size cap.
        "-ar".into(),
        "16000".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        target.to_string_lossy().into_owned(),
    ]
}

/// This Blob's home folder.
fn home_of(app: &tauri::AppHandle, id: &str) -> Result<PathBuf> {
    crate::home::home_root(&crate::store::data_root(app)?, id)
}

/// Size of a produced file, as the caller reports it.
fn produced(target: &Path, name: &str) -> Result<MediaOutput> {
    let bytes = std::fs::metadata(target)
        .map_err(|error| Error::Io(error.to_string()))?
        .len();
    Ok(MediaOutput {
        name: name.to_string(),
        bytes,
    })
}

/// What ffprobe can say about one file in this Blob's home.
#[tauri::command]
pub(crate) async fn media_info(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<MediaInfo> {
    let home = home_of(&app, &id)?;
    let source = crate::home::resolve_in_home(&home, &path)?;
    if !source.is_file() {
        return Err(Error::FileNotFound);
    }
    let args = info_args(&source);
    let report = tauri::async_runtime::spawn_blocking(move || run("ffprobe", &args, None))
        .await
        .map_err(|error| Error::Io(error.to_string()))??;
    Ok(MediaInfo { report })
}

/// Cut a time range out of one file into another, both inside the home.
#[tauri::command]
pub(crate) async fn media_clip(
    app: tauri::AppHandle,
    id: String,
    path: String,
    output: String,
    start: String,
    duration: String,
) -> Result<MediaOutput> {
    check_time(&start)?;
    check_time(&duration)?;
    let home = home_of(&app, &id)?;
    let (source, target) = resolve_pair(&home, &path, &output)?;
    let args = clip_args(&source, &target, &start, &duration);
    let watched = target.clone();
    tauri::async_runtime::spawn_blocking(move || run("ffmpeg", &args, Some(&watched)))
        .await
        .map_err(|error| Error::Io(error.to_string()))??;
    produced(&target, &output)
}

/// Lift the audio track out of one file into another, both inside the home.
#[tauri::command]
pub(crate) async fn media_audio(
    app: tauri::AppHandle,
    id: String,
    path: String,
    output: String,
) -> Result<MediaOutput> {
    let home = home_of(&app, &id)?;
    let (source, target) = resolve_pair(&home, &path, &output)?;
    let args = audio_args(&source, &target);
    let watched = target.clone();
    tauri::async_runtime::spawn_blocking(move || run("ffmpeg", &args, Some(&watched)))
        .await
        .map_err(|error| Error::Io(error.to_string()))??;
    produced(&target, &output)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh scratch home, unique per test so they can run in parallel.
    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "blobbies-media-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn every_argv_pins_the_input_to_a_local_file() {
        // The single most important flag here: without it a crafted playlist
        // reaches the network from inside a turn that also has `web_fetch`.
        let source = Path::new("/home/in.mp4");
        let target = Path::new("/home/out.mp4");
        for args in [
            info_args(source),
            clip_args(source, target, "0", "5"),
            audio_args(source, target),
        ] {
            let position = args
                .iter()
                .position(|arg| arg == "-protocol_whitelist")
                .expect("the whitelist is always passed");
            assert_eq!(args.get(position + 1).map(String::as_str), Some("file"));
            // Nothing may re-open the format from input, and nothing may
            // overwrite silently.
            assert!(!args.contains(&"-f".to_string()));
            assert!(!args.contains(&"-y".to_string()));
            // The input is always introduced by `-i`, so a path can never be
            // read as a flag however it begins.
            let input = args.iter().position(|arg| arg == "-i").expect("-i is used");
            assert_eq!(
                args.get(input + 1).map(String::as_str),
                Some(source.to_string_lossy().as_ref())
            );
        }
    }

    #[test]
    fn a_write_argv_refuses_a_terminal_prompt() {
        // Without `-nostdin` an ffmpeg that decides to ask something pins the
        // turn until the deadline.
        assert!(clip_args(Path::new("a"), Path::new("b"), "0", "1").contains(&"-nostdin".into()));
        assert!(audio_args(Path::new("a"), Path::new("b")).contains(&"-nostdin".into()));
    }

    #[test]
    fn a_time_that_could_be_read_as_a_flag_is_refused() {
        // The way a fixed argv turns back into an open one: a value beginning
        // with `-` is a flag to the program receiving it.
        assert!(check_time("-i").is_err());
        assert!(check_time("-f lavfi").is_err());
        assert!(check_time("5;rm -rf /").is_err());
        assert!(check_time("").is_err());
        assert!(check_time(&"1".repeat(MAX_TIME_CHARS + 1)).is_err());
        // And the shapes ffmpeg actually documents still work.
        for good in ["0", "5", "5.5", "00:01:30", "01:02:03.250"] {
            check_time(good).expect("a real offset is accepted");
        }
    }

    #[test]
    fn neither_end_of_a_job_can_leave_the_home_folder() {
        let home = scratch("escape");
        std::fs::write(home.join("clip.mp4"), b"not really media").expect("fixture");

        // Input escape.
        assert!(resolve_pair(&home, "../../../etc/passwd", "out.wav").is_err());
        // Output escape — the half that would let a Blob write anywhere.
        assert!(resolve_pair(&home, "clip.mp4", "../../escaped.wav").is_err());
        assert!(resolve_pair(&home, "clip.mp4", "/tmp/escaped.wav").is_err());
        // A missing input is refused before any process is started.
        assert!(resolve_pair(&home, "nothing.mp4", "out.wav").is_err());
        // An existing output is never clobbered.
        std::fs::write(home.join("taken.wav"), b"precious").expect("fixture");
        assert!(resolve_pair(&home, "clip.mp4", "taken.wav").is_err());
        assert_eq!(
            std::fs::read(home.join("taken.wav")).expect("still there"),
            b"precious"
        );

        // And the legitimate case still works, creating the output's folder.
        let (source, target) = resolve_pair(&home, "clip.mp4", "audio/out.wav").expect("allowed");
        assert!(source.starts_with(home.canonicalize().expect("home")));
        assert!(target.starts_with(home.canonicalize().expect("home")));
        assert!(target.parent().expect("parent").is_dir());

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_junk_file_is_refused_rather_than_producing_an_empty_result() {
        if !ffmpeg_present() {
            return;
        }
        let home = scratch("junk");
        std::fs::write(home.join("fake.mp4"), b"this is not media at all").expect("fixture");
        let source = crate::home::resolve_in_home(&home, "fake.mp4").expect("resolves");
        let error = run("ffprobe", &info_args(&source), None);
        assert!(error.is_err(), "ffprobe must not claim to read junk");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_real_clip_round_trips_through_ffmpeg() {
        // Gated: the argv tests above are the ones that must always run. This
        // proves the flags actually work when a binary is there to run them.
        if !ffmpeg_present() {
            return;
        }
        let home = scratch("roundtrip");
        // Generated rather than committed: a binary fixture in the repo is a
        // thing to trust, and `lavfi` builds one deterministically. It is used
        // as a *source*, through the same argv builders under test.
        let made = Command::new(which("ffmpeg").expect("present"))
            .args([
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=3:size=64x48:rate=10",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                &home.join("source.mp4").to_string_lossy(),
            ])
            .status();
        if !made.is_ok_and(|status| status.success()) {
            // A build of ffmpeg without libx264 is a fine reason to skip.
            let _ = std::fs::remove_dir_all(&home);
            return;
        }

        let source = crate::home::resolve_in_home(&home, "source.mp4").expect("resolves");
        let report = run("ffprobe", &info_args(&source), None).expect("probes");
        assert!(
            report.contains("duration="),
            "the report describes the file"
        );

        let (input, target) = resolve_pair(&home, "source.mp4", "cut.mp4").expect("allowed");
        run(
            "ffmpeg",
            &clip_args(&input, &target, "0", "1"),
            Some(&target),
        )
        .expect("clips");
        assert!(target.is_file(), "the clip landed inside the home folder");
        assert!(
            std::fs::metadata(&target).expect("meta").len() > 0,
            "and it is not empty"
        );

        let (input, audio) = resolve_pair(&home, "source.mp4", "track.wav").expect("allowed");
        run("ffmpeg", &audio_args(&input, &audio), Some(&audio)).expect("extracts audio");
        assert!(audio.is_file());

        let _ = std::fs::remove_dir_all(&home);
    }
}
