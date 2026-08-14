use crate::error::{Error, Result};

/// Upper bound on any free-text field arriving from the webview.
const MAX_INPUT_CHARS: usize = 128;

/// Validate a free-text value coming from the frontend.
///
/// The webview is a hostile boundary even in a local app: anything rendered in
/// it (or injected into it) can call commands, so every string is length-bound
/// and trimmed here rather than deeper in the call stack.
fn validate_text(value: &str) -> Result<&str> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return Err(Error::EmptyInput);
    }
    if trimmed.chars().count() > MAX_INPUT_CHARS {
        return Err(Error::InputTooLong {
            max: MAX_INPUT_CHARS,
        });
    }

    Ok(trimmed)
}

/// Example command. See <https://tauri.app/develop/calling-rust/>
#[tauri::command]
pub(crate) fn greet(name: &str) -> Result<String> {
    let name = validate_text(name)?;
    Ok(format!("Hello, {name}! You've been greeted from Rust!"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greets_a_valid_name() {
        assert_eq!(
            greet("  Ada  ").unwrap(),
            "Hello, Ada! You've been greeted from Rust!"
        );
    }

    #[test]
    fn rejects_blank_input() {
        assert!(matches!(greet("   "), Err(Error::EmptyInput)));
    }

    #[test]
    fn rejects_oversized_input() {
        let long = "a".repeat(MAX_INPUT_CHARS + 1);
        assert!(matches!(greet(&long), Err(Error::InputTooLong { .. })));
    }

    #[test]
    fn counts_characters_not_bytes() {
        let emoji = "🦀".repeat(MAX_INPUT_CHARS);
        assert!(greet(&emoji).is_ok());
    }
}
