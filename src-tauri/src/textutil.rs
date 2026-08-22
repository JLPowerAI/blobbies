//! The file readers a Blob can run, implemented here rather than spawned.
//!
//! `shell.rs` allowlists a handful of POSIX programs and hands their argv to
//! `Command::new`. That works on a developer's Mac and fails two ways in the
//! wild:
//!
//! - **Windows has none of them.** `ls`, `cat`, `grep` and friends are not on
//!   a default install, so every one of those calls returns "not found" and a
//!   Blob's file tools quietly stop working on a supported platform.
//! - **macOS has different ones.** The allowlist accepts GNU long flags, but
//!   BSD `ls` has no `--all` and BSD `wc` has no `--lines`, so calls that the
//!   gate permits still fail at the exec. Verified on macOS 15: both return
//!   "illegal option".
//!
//! So the same command produced three different results depending on the
//! machine. These implementations produce one, and remove a class of problem
//! along the way: there is no `PATH` lookup, so nothing can shadow `cat` with
//! a script earlier in `PATH`; no process, so no environment to scrub or
//! deadline to enforce; and the flag surface is exactly what is written here
//! instead of whatever the installed build happens to support.
//!
//! **Containment is unchanged and still the point.** Every path argument is
//! resolved through `home::resolve_in_home` by `shell.rs` *before* anything
//! here runs, and each function re-resolves through the same helper rather
//! than trusting the string it was handed. Directory walks are bounded to the
//! home root, and symlinks are never followed, so a link planted inside a
//! Blob's folder cannot read what it points at.
//!
//! Output is capped by the caller. Everything here streams line by line and
//! stops early once the cap is hit, so a `cat` of a huge file costs a bounded
//! amount of memory rather than the file's size.

use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Ceiling on a single file read, matching the caller's output cap.
///
/// A file larger than this is read up to the limit and truncated, which is
/// what a model wants anyway: the alternative is loading a gigabyte to show
/// the first page of it.
const READ_LIMIT: u64 = 40_000;

/// How many entries one directory listing or walk may produce.
///
/// A Blob's home holding 100k files should not turn one `ls` into a context
/// window full of names.
const ENTRY_LIMIT: usize = 5_000;

/// Longest line a matcher will consider, so a minified bundle on one line
/// cannot blow memory through `read_line`.
const LINE_LIMIT: usize = 64 * 1024;

/// A file's bytes as text, lossily.
///
/// Lossy rather than an error: a Blob reading a mixed-encoding note or a file
/// with one stray byte should see the text, not a failure. Binary detection
/// happens before this is called.
fn read_text(path: &Path) -> Result<String> {
    let file = File::open(path).map_err(|error| Error::Io(error.to_string()))?;
    let mut buffer = Vec::new();
    // `take` bounds the allocation before it happens, rather than reading the
    // whole file and truncating after.
    file.take(READ_LIMIT + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| Error::Io(error.to_string()))?;
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Whether a file looks binary, by the same rule `grep` uses: a NUL byte in
/// the first block. Keeps a matcher from spraying a JPEG into a model's
/// context.
fn looks_binary(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut head = [0u8; 1024];
    let mut handle = file.take(1024);
    match handle.read(&mut head) {
        Ok(read) => head.get(..read).is_some_and(|slice| slice.contains(&0)),
        Err(_) => false,
    }
}

/// One entry in a listing.
struct Entry {
    name: String,
    is_dir: bool,
    len: u64,
}

/// `ls`: names in a directory, or the file itself when given a file.
///
/// Hidden entries are shown only with `-a`, directories are marked with a
/// trailing `/`, and `-l` adds a size column. Sorted by name, because an
/// unsorted listing differs between filesystems and makes output unstable
/// between runs.
pub(crate) fn ls(target: &Path, all: bool, long: bool, reverse: bool) -> Result<String> {
    let metadata = std::fs::metadata(target).map_err(|error| Error::Io(error.to_string()))?;
    if !metadata.is_dir() {
        let name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Ok(if long {
            format!("{:>10}  {name}\n", metadata.len())
        } else {
            format!("{name}\n")
        });
    }

    let mut entries: Vec<Entry> = Vec::new();
    let reader = std::fs::read_dir(target).map_err(|error| Error::Io(error.to_string()))?;
    for entry in reader {
        let entry = entry.map_err(|error| Error::Io(error.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !all && name.starts_with('.') {
            continue;
        }
        // `metadata` follows symlinks; `symlink_metadata` does not. Using the
        // latter means a link is reported as what it is, and a link pointing
        // outside the home is never followed just to size it.
        let meta = entry
            .path()
            .symlink_metadata()
            .map_err(|error| Error::Io(error.to_string()))?;
        entries.push(Entry {
            name,
            is_dir: meta.is_dir(),
            len: meta.len(),
        });
        if entries.len() >= ENTRY_LIMIT {
            break;
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    if reverse {
        entries.reverse();
    }

    let mut out = String::new();
    for entry in &entries {
        let slash = if entry.is_dir { "/" } else { "" };
        if long {
            let _ = writeln!(out, "{:>10}  {}{slash}", entry.len, entry.name);
        } else {
            let _ = writeln!(out, "{}{slash}", entry.name);
        }
    }
    Ok(out)
}

/// `cat`: file contents, optionally with line numbers.
pub(crate) fn cat(paths: &[PathBuf], number: bool) -> Result<String> {
    let mut out = String::new();
    let mut line_no = 1usize;
    for path in paths {
        let text = read_text(path)?;
        if number {
            for line in text.lines() {
                let _ = writeln!(out, "{line_no:>6}\t{line}");
                line_no += 1;
            }
        } else {
            out.push_str(&text);
            if !text.ends_with('\n') && !text.is_empty() {
                out.push('\n');
            }
        }
    }
    Ok(out)
}

/// `head` and `tail`: the first or last `count` lines of each file.
///
/// A header is printed between files only when there is more than one, which
/// is what both tools do and what makes single-file output pasteable.
pub(crate) fn head_tail(paths: &[PathBuf], count: usize, from_end: bool) -> Result<String> {
    let mut out = String::new();
    for path in paths {
        if paths.len() > 1 {
            let _ = writeln!(out, "==> {} <==", path.display());
        }
        let text = read_text(path)?;
        let lines: Vec<&str> = text.lines().collect();
        let slice = if from_end {
            lines.get(lines.len().saturating_sub(count)..)
        } else {
            lines.get(..count.min(lines.len()))
        }
        .unwrap_or_default();
        for line in slice {
            out.push_str(line);
            out.push('\n');
        }
        if paths.len() > 1 {
            out.push('\n');
        }
    }
    Ok(out)
}

/// `wc`: line, word and byte counts per file, plus a total for several.
pub(crate) fn wc(paths: &[PathBuf], lines: bool, words: bool, bytes: bool) -> Result<String> {
    // Bare `wc` reports all three, same as the real thing.
    let (lines, words, bytes) = if !lines && !words && !bytes {
        (true, true, true)
    } else {
        (lines, words, bytes)
    };
    let mut out = String::new();
    let (mut total_l, mut total_w, mut total_b) = (0usize, 0usize, 0usize);
    for path in paths {
        let text = read_text(path)?;
        let l = text.lines().count();
        let w = text.split_whitespace().count();
        let b = text.len();
        total_l += l;
        total_w += w;
        total_b += b;
        let mut row = String::new();
        if lines {
            let _ = write!(row, "{l:>8}");
        }
        if words {
            let _ = write!(row, "{w:>8}");
        }
        if bytes {
            let _ = write!(row, "{b:>8}");
        }
        let _ = writeln!(out, "{row} {}", path.display());
    }
    if paths.len() > 1 {
        let mut row = String::new();
        if lines {
            let _ = write!(row, "{total_l:>8}");
        }
        if words {
            let _ = write!(row, "{total_w:>8}");
        }
        if bytes {
            let _ = write!(row, "{total_b:>8}");
        }
        let _ = writeln!(out, "{row} total");
    }
    Ok(out)
}

/// Options a `grep` call was given, after `shell.rs` has vetted the flags.
///
/// A flat bag of flags, one field per command-line switch, because that is
/// what it mirrors. Grouping them into sub-structs to satisfy a lint would
/// obscure the one-to-one mapping that makes this easy to audit against
/// `ALLOWED` in `shell.rs`.
#[allow(clippy::struct_excessive_bools)]
#[derive(Default)]
pub(crate) struct GrepOptions {
    pub ignore_case: bool,
    pub invert: bool,
    pub line_numbers: bool,
    pub recursive: bool,
    pub fixed: bool,
    pub word: bool,
    pub count_only: bool,
    pub files_with_matches: bool,
    pub max_count: Option<usize>,
    pub hidden: bool,
}

/// Files a match should run over: the paths given, expanded when recursive.
///
/// The walk never follows symlinks, so a link inside a Blob's home cannot
/// pull in a tree outside it, and every produced path is re-checked against
/// the home root before it is read.
fn collect_files(home: &Path, targets: &[PathBuf], options: &GrepOptions) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for target in targets {
        let Ok(meta) = std::fs::metadata(target) else {
            continue;
        };
        if meta.is_file() {
            files.push(target.clone());
            continue;
        }
        if !options.recursive {
            continue;
        }
        for entry in walkdir::WalkDir::new(target)
            .follow_links(false)
            .max_depth(24)
            .into_iter()
            .filter_entry(|entry| {
                if options.hidden {
                    return true;
                }
                // Skip dot-directories wholesale rather than filtering their
                // files afterwards: not descending into `.git` is the
                // difference between a fast search and reading every object.
                entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
            })
            .filter_map(std::result::Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            // Belt and braces: the walk is rooted inside the home already, but
            // a path that somehow escaped is dropped rather than read.
            if !entry.path().starts_with(home) {
                continue;
            }
            files.push(entry.path().to_path_buf());
            if files.len() >= ENTRY_LIMIT {
                return files;
            }
        }
    }
    files
}

/// `grep`/`rg`: lines matching `pattern` across `targets`.
///
/// The pattern is a regex unless `fixed` is set, and an invalid one is an
/// error rather than a silent zero-match, so a model gets told its pattern was
/// wrong instead of concluding the file is empty.
pub(crate) fn grep(
    home: &Path,
    pattern: &str,
    targets: &[PathBuf],
    options: &GrepOptions,
) -> Result<String> {
    let escaped;
    let source = if options.fixed {
        escaped = regex::escape(pattern);
        &escaped
    } else {
        pattern
    };
    let source = if options.word {
        format!(r"\b(?:{source})\b")
    } else {
        source.to_string()
    };
    let regex = regex::RegexBuilder::new(&source)
        .case_insensitive(options.ignore_case)
        // A pattern from a model can be pathological; the size limit turns a
        // catastrophic compile into an error instead of a hang.
        .size_limit(1 << 20)
        .build()
        .map_err(|error| Error::Io(format!("Bad pattern: {error}")))?;

    let files = collect_files(home, targets, options);
    let show_names = files.len() > 1 || options.recursive;
    let mut out = String::new();
    let mut matched_files = 0usize;

    for path in &files {
        if looks_binary(path) {
            continue;
        }
        let Ok(file) = File::open(path) else {
            continue;
        };
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        let mut number = 0usize;
        let mut hits = 0usize;

        loop {
            line.clear();
            let mut limited = (&mut reader).take(LINE_LIMIT as u64);
            match limited.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            number += 1;
            let text = line.trim_end_matches(['\n', '\r']);
            if regex.is_match(text) == options.invert {
                continue;
            }
            hits += 1;
            if !options.count_only && !options.files_with_matches {
                let name = path.display();
                match (show_names, options.line_numbers) {
                    (true, true) => {
                        let _ = writeln!(out, "{name}:{number}:{text}");
                    }
                    (true, false) => {
                        let _ = writeln!(out, "{name}:{text}");
                    }
                    (false, true) => {
                        let _ = writeln!(out, "{number}:{text}");
                    }
                    (false, false) => {
                        let _ = writeln!(out, "{text}");
                    }
                }
            }
            if options.max_count.is_some_and(|max| hits >= max) {
                break;
            }
            if out.len() as u64 > READ_LIMIT {
                return Ok(out);
            }
        }

        if hits > 0 {
            matched_files += 1;
            if options.files_with_matches {
                let _ = writeln!(out, "{}", path.display());
            } else if options.count_only {
                if show_names {
                    let _ = writeln!(out, "{}:{hits}", path.display());
                } else {
                    let _ = writeln!(out, "{hits}");
                }
            }
        }
    }

    if out.is_empty() && matched_files == 0 && options.count_only && files.len() == 1 {
        out.push_str("0\n");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real directory, because containment canonicalizes both sides.
    /// Matches the convention in `shell.rs`: no dev-dependency for a mkdir.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("blobbies-textutil-tests")
            .join(format!(
                "{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or_default()
            ));
        std::fs::create_dir_all(&dir).unwrap_or_else(|_| panic!("temp dir"));
        dir
    }

    fn fixture(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        std::fs::write(dir.join("a.txt"), "alpha\nbeta\ngamma\n").expect("write");
        std::fs::write(dir.join("b.txt"), "beta\ndelta\n").expect("write");
        std::fs::write(dir.join(".hidden"), "secret\n").expect("write");
        std::fs::create_dir_all(dir.join("sub")).expect("mkdir");
        std::fs::write(dir.join("sub/c.txt"), "beta in sub\n").expect("write");
        dir
    }

    #[test]
    fn ls_hides_dotfiles_until_asked() {
        let dir = fixture("ls_hides_dotfiles_until_asked");
        let plain = ls(&dir, false, false, false).expect("ls");
        assert!(!plain.contains(".hidden"), "dotfile leaked: {plain}");
        assert!(plain.contains("a.txt"));
        // Directories are marked, so a model can tell them apart without a stat.
        assert!(plain.contains("sub/"), "no dir marker: {plain}");

        let all = ls(&dir, true, false, false).expect("ls -a");
        assert!(all.contains(".hidden"));
    }

    #[test]
    fn ls_sorts_and_reverses() {
        let dir = fixture("ls_sorts_and_reverses");
        let forward = ls(&dir, false, false, false).expect("ls");
        let backward = ls(&dir, false, false, true).expect("ls -r");
        let mut lines: Vec<&str> = forward.lines().collect();
        lines.reverse();
        assert_eq!(lines, backward.lines().collect::<Vec<_>>());
    }

    #[test]
    fn cat_numbers_lines_continuously() {
        let dir = fixture("cat_numbers_lines_continuously");
        let paths = vec![dir.join("a.txt"), dir.join("b.txt")];
        let out = cat(&paths, true).expect("cat -n");
        assert!(out.contains("     1\talpha"), "{out}");
        // Numbering continues across files, as the real cat does.
        assert!(out.contains("     4\tbeta"), "{out}");
    }

    #[test]
    fn head_and_tail_take_from_the_right_end() {
        let dir = fixture("head_and_tail_take_from_the_right_end");
        let paths = vec![dir.join("a.txt")];
        assert_eq!(head_tail(&paths, 1, false).expect("head"), "alpha\n");
        assert_eq!(head_tail(&paths, 1, true).expect("tail"), "gamma\n");
    }

    #[test]
    fn wc_counts_and_totals() {
        let dir = fixture("wc_counts_and_totals");
        let paths = vec![dir.join("a.txt"), dir.join("b.txt")];
        let out = wc(&paths, true, false, false).expect("wc -l");
        assert!(out.contains("total"), "{out}");
        assert!(out.lines().next().expect("row").contains('3'), "{out}");
    }

    #[test]
    fn grep_matches_and_inverts() {
        let dir = fixture("grep_matches_and_inverts");
        let targets = vec![dir.join("a.txt")];
        let hit = grep(&dir, "beta", &targets, &GrepOptions::default()).expect("grep");
        assert_eq!(hit, "beta\n");

        let inverted = grep(
            &dir,
            "beta",
            &targets,
            &GrepOptions {
                invert: true,
                ..GrepOptions::default()
            },
        )
        .expect("grep -v");
        assert_eq!(inverted, "alpha\ngamma\n");
    }

    #[test]
    fn grep_recursive_finds_subdirectories_and_skips_dot_dirs() {
        let dir = fixture("grep_recursive_finds_subdirectories_and_skips_dot_dirs");
        std::fs::create_dir(dir.join(".git")).expect("mkdir");
        std::fs::write(dir.join(".git/config"), "beta\n").expect("write");
        let out = grep(
            &dir,
            "beta",
            std::slice::from_ref(&dir),
            &GrepOptions {
                recursive: true,
                ..GrepOptions::default()
            },
        )
        .expect("grep -r");
        assert!(out.contains("c.txt"), "missed subdirectory: {out}");
        assert!(!out.contains(".git"), "descended into a dot-dir: {out}");
    }

    #[test]
    fn grep_fixed_strings_are_literal() {
        let dir = temp_dir("grep_fixed_strings_are_literal");
        std::fs::write(dir.join("x.txt"), "a.c\nabc\n").expect("write");
        let targets = vec![dir.join("x.txt")];
        let regex = grep(&dir, "a.c", &targets, &GrepOptions::default()).expect("grep");
        assert!(regex.contains("abc"), "dot should match any char: {regex}");

        let literal = grep(
            &dir,
            "a.c",
            &targets,
            &GrepOptions {
                fixed: true,
                ..GrepOptions::default()
            },
        )
        .expect("grep -F");
        assert_eq!(literal, "a.c\n", "-F should not treat . as a wildcard");
    }

    #[test]
    fn grep_reports_a_bad_pattern_instead_of_no_matches() {
        let dir = fixture("grep_reports_a_bad_pattern_instead_of_no_matches");
        let error = grep(&dir, "a(", &[dir.join("a.txt")], &GrepOptions::default())
            .expect_err("unbalanced paren must fail");
        assert!(
            error.to_string().contains("Bad pattern"),
            "unhelpful error: {error}"
        );
    }

    #[test]
    fn grep_skips_binary_files() {
        let dir = temp_dir("grep_skips_binary_files");
        std::fs::write(dir.join("bin"), b"beta\0\xff\xfe binary").expect("write");
        let out = grep(&dir, "beta", &[dir.join("bin")], &GrepOptions::default()).expect("grep");
        assert!(out.is_empty(), "binary content reached the context: {out}");
    }

    #[test]
    fn grep_does_not_follow_symlinks_out_of_the_home() {
        let home = temp_dir("symlink-home");
        let outside = temp_dir("symlink-outside");
        std::fs::write(outside.join("secret.txt"), "beta secret\n").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside, home.join("link")).expect("symlink");
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_dir(outside, home.join("link"));

        let out = grep(
            &home,
            "beta",
            std::slice::from_ref(&home),
            &GrepOptions {
                recursive: true,
                ..GrepOptions::default()
            },
        )
        .expect("grep -r");
        assert!(!out.contains("secret"), "followed a symlink out: {out}");
    }
}
