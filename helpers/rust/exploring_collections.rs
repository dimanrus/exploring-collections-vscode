//! Exploring Collections helper for Rust debuggees.
//!
//! Add this module to your crate:
//!
//! ```ignore
//! mod exploring_collections;
//!
//! fn main() {
//!     let temperatures = vec![Temperature { city: "Seoul", degree: 21 }];
//!     // Then, from the debug console while stopped at a breakpoint:
//!     //   exploring_collections::dump_json(&temperatures)
//! }
//! ```
//!
//! The helper reformats the `Debug` representation of a value into the JSON
//! envelope the extension understands:
//!
//! ```text
//! { "__ec": 1, "kind": "sequence" | "mapping" | "record", "total": 14, "items": [ ... ] }
//! ```
//!
//! Parsing `Debug` output means the helper works with *any* type that derives
//! `Debug` — no attributes, no traits to implement and no external crates.

use std::fmt::Debug;

/// Version of this helper, aligned with the extension release.
pub const VERSION: &str = "1.0.0";

/// Default nesting limit.
pub const DEFAULT_MAX_DEPTH: usize = 8;
/// Default element limit per container.
pub const DEFAULT_MAX_ITEMS: usize = 200_000;

/// Serializes a value with the default limits.
pub fn dump_json<T: Debug + ?Sized>(value: &T) -> String {
    dump_json_with_limits(value, DEFAULT_MAX_DEPTH, DEFAULT_MAX_ITEMS)
}

/// Serializes a value into the envelope JSON string.
pub fn dump_json_with_limits<T: Debug + ?Sized>(value: &T, max_depth: usize, max_items: usize) -> String {
    let text = format!("{:#?}", value);
    let mut parser = Parser::new(&text, max_depth.max(1));
    let parsed = parser.parse();
    let mut out = String::with_capacity(text.len() + 64);
    write_envelope(&parsed, &mut out, max_items.max(1), max_depth.max(1));
    out
}

/// Returns a short, human readable description of a value.
pub fn describe<T: Debug + ?Sized>(value: &T) -> String {
    let text = format!("{:?}", value);
    if text.chars().count() <= 120 {
        text
    } else {
        let mut shortened: String = text.chars().take(119).collect();
        shortened.push('…');
        shortened
    }
}

/// Minimal JSON value model produced from the `Debug` text.
#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    /// Raw numeric text, already validated.
    Number(String),
    Text(String),
    Array(Vec<Json>),
    /// Named fields, produced by `Name { field: value }` or by a struct.
    Object(Vec<(String, Json)>),
    /// Key/value entries, produced by `{ key: value }` (map or set-like braces).
    Mapping(Vec<(Json, Json)>),
}

struct Parser {
    chars: Vec<char>,
    position: usize,
    max_depth: usize,
}

impl Parser {
    fn new(text: &str, max_depth: usize) -> Self {
        Self {
            chars: text.chars().collect(),
            position: 0,
            max_depth,
        }
    }

    fn parse(&mut self) -> Json {
        let value = self.parse_value(0);
        value
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.position).copied()
    }

    fn skip_whitespace(&mut self) {
        while let Some(character) = self.peek() {
            if character.is_whitespace() || character == ',' {
                // Commas are separators; skipping them here keeps the loops simple.
                if character == ',' {
                    self.position += 1;
                    continue;
                }
                self.position += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self, depth: usize) -> Json {
        self.skip_whitespace();
        let Some(character) = self.peek() else {
            return Json::Null;
        };

        if depth >= self.max_depth {
            self.skip_to_end_of_value();
            return Json::Text("<max depth>".to_string());
        }

        match character {
            '"' => Json::Text(self.parse_string()),
            '\'' => Json::Text(self.parse_char()),
            '[' => self.parse_sequence(']', depth),
            '(' => self.parse_sequence(')', depth),
            '{' => self.parse_braces(depth),
            '-' | '+' | '0'..='9' | '.' => self.parse_number(),
            _ => self.parse_identifier_value(depth),
        }
    }

    /// Reads a quoted string, decoding the escapes `Debug` produces.
    fn parse_string(&mut self) -> String {
        self.position += 1;
        let mut result = String::new();
        while let Some(character) = self.peek() {
            self.position += 1;
            match character {
                '"' => break,
                '\\' => {
                    let Some(escape) = self.peek() else { break };
                    self.position += 1;
                    match escape {
                        'n' => result.push('\n'),
                        'r' => result.push('\r'),
                        't' => result.push('\t'),
                        '0' => result.push('\0'),
                        '\\' => result.push('\\'),
                        '"' => result.push('"'),
                        '\'' => result.push('\''),
                        'u' => {
                            // `\u{1f600}`
                            if self.peek() == Some('{') {
                                self.position += 1;
                                let mut digits = String::new();
                                while let Some(digit) = self.peek() {
                                    self.position += 1;
                                    if digit == '}' {
                                        break;
                                    }
                                    digits.push(digit);
                                }
                                if let Ok(code) = u32::from_str_radix(&digits, 16) {
                                    if let Some(decoded) = char::from_u32(code) {
                                        result.push(decoded);
                                    }
                                }
                            }
                        }
                        other => result.push(other),
                    }
                }
                other => result.push(other),
            }
        }
        result
    }

    /// Reads a character literal such as `'a'`.
    fn parse_char(&mut self) -> String {
        self.position += 1;
        let mut result = String::new();
        while let Some(character) = self.peek() {
            self.position += 1;
            match character {
                '\'' => break,
                '\\' => {
                    let Some(escape) = self.peek() else { break };
                    self.position += 1;
                    match escape {
                        'n' => result.push('\n'),
                        'r' => result.push('\r'),
                        't' => result.push('\t'),
                        '0' => result.push('\0'),
                        '\\' => result.push('\\'),
                        '\'' => result.push('\''),
                        'u' => {
                            if self.peek() == Some('{') {
                                self.position += 1;
                                let mut digits = String::new();
                                while let Some(digit) = self.peek() {
                                    self.position += 1;
                                    if digit == '}' {
                                        break;
                                    }
                                    digits.push(digit);
                                }
                                if let Ok(code) = u32::from_str_radix(&digits, 16) {
                                    if let Some(decoded) = char::from_u32(code) {
                                        result.push(decoded);
                                    }
                                }
                            }
                        }
                        other => result.push(other),
                    }
                }
                other => result.push(other),
            }
        }
        result
    }

    /// Reads a number, including the `NaN` / `inf` spellings `Debug` uses.
    fn parse_number(&mut self) -> Json {
        let mut raw = String::new();
        if let Some(sign) = self.peek() {
            if sign == '-' || sign == '+' {
                raw.push(sign);
                self.position += 1;
            }
        }

        // `inf` and `NaN` are printed as words.
        let mut probe = self.position;
        let mut word = String::new();
        while let Some(character) = self.chars.get(probe).copied() {
            if character.is_ascii_alphabetic() {
                word.push(character);
                probe += 1;
            } else {
                break;
            }
        }
        let lowered = word.to_ascii_lowercase();
        if lowered == "inf" || lowered == "infinity" {
            self.position = probe;
            return Json::Text(if raw.starts_with('-') { "-Infinity" } else { "Infinity" }.to_string());
        }
        if lowered == "nan" {
            self.position = probe;
            return Json::Text("NaN".to_string());
        }

        while let Some(character) = self.peek() {
            let previous = self.chars.get(self.position.wrapping_sub(1)).copied().unwrap_or(' ');
            let is_exponent_sign = (character == '-' || character == '+')
                && (previous == 'e' || previous == 'E');
            if character.is_ascii_digit()
                || character == '.'
                || character == '_'
                || character.is_ascii_alphabetic()
                || is_exponent_sign
            {
                raw.push(character);
                self.position += 1;
            } else {
                break;
            }
        }

        let normalized = strip_numeric_suffix(&raw);
        if is_numeric(&normalized) {
            Json::Number(normalized)
        } else {
            Json::Text(raw)
        }
    }

    /// Reads `[a, b, c]`, `(a, b)` and `(a,)` into an array.
    fn parse_sequence(&mut self, closer: char, depth: usize) -> Json {
        self.position += 1;
        let mut elements: Vec<Json> = Vec::new();
        loop {
            self.skip_whitespace();
            match self.peek() {
                None => break,
                Some(character) if character == closer => {
                    self.position += 1;
                    break;
                }
                _ => {}
            }
            elements.push(self.parse_value(depth + 1));
        }
        Json::Array(elements)
    }

    /// Reads `{ ... }`: either a map, a set or a struct body without its name.
    fn parse_braces(&mut self, depth: usize) -> Json {
        self.position += 1;
        let mut pairs: Vec<(Json, Json)> = Vec::new();
        let mut values: Vec<Json> = Vec::new();
        let mut has_pairs = false;

        loop {
            self.skip_whitespace();
            match self.peek() {
                None => break,
                Some('}') => {
                    self.position += 1;
                    break;
                }
                _ => {}
            }
            let key = self.parse_value(depth + 1);
            self.skip_whitespace();
            if self.peek() == Some(':') {
                self.position += 1;
                let value = self.parse_value(depth + 1);
                pairs.push((key, value));
                has_pairs = true;
            } else {
                values.push(key);
            }
        }

        if has_pairs {
            // Values without an explicit key (only possible in malformed input)
            // are folded in with their index so nothing is lost.
            for (index, value) in values.into_iter().enumerate() {
                pairs.push((Json::Number(index.to_string()), value));
            }
            Json::Mapping(pairs)
        } else {
            Json::Array(values)
        }
    }

    /// Reads an identifier, which may be a unit variant, a struct or a tuple variant.
    fn parse_identifier_value(&mut self, depth: usize) -> Json {
        let mut name = String::new();
        while let Some(character) = self.peek() {
            if character.is_alphanumeric() || character == '_' {
                name.push(character);
                self.position += 1;
            } else {
                break;
            }
        }

        let save = self.position;
        self.skip_whitespace();
        match self.peek() {
            Some('{') => {
                let body = self.parse_braces(depth);
                match body {
                    Json::Mapping(pairs) => {
                        let fields = pairs
                            .into_iter()
                            .map(|(key, value)| (json_key_name(&key), value))
                            .collect();
                        Json::Object(fields)
                    }
                    Json::Array(elements) => {
                        let fields = elements
                            .into_iter()
                            .enumerate()
                            .map(|(index, value)| (index.to_string(), value))
                            .collect();
                        Json::Object(fields)
                    }
                    other => other,
                }
            }
            Some('(') => {
                let body = self.parse_sequence(')', depth);
                let elements = match body {
                    Json::Array(elements) => elements,
                    other => vec![other],
                };
                // `Some(x)` behaves like `x`, everything else keeps its shape.
                if name == "Some" && elements.len() == 1 {
                    return elements.into_iter().next().unwrap_or(Json::Null);
                }
                if name == "Ok" && elements.len() == 1 {
                    return elements.into_iter().next().unwrap_or(Json::Null);
                }
                if elements.is_empty() {
                    return Json::Text(name);
                }
                let mut fields: Vec<(String, Json)> = Vec::with_capacity(elements.len() + 1);
                fields.push(("Case".to_string(), Json::Text(name)));
                for (index, value) in elements.into_iter().enumerate() {
                    fields.push((index.to_string(), value));
                }
                Json::Object(fields)
            }
            _ => {
                self.position = save;
                let lowered = name.to_ascii_lowercase();
                if name == "None" || name.is_empty() {
                    Json::Null
                } else if lowered == "true" {
                    Json::Bool(true)
                } else if lowered == "false" {
                    Json::Bool(false)
                } else if lowered == "inf" || lowered == "infinity" {
                    Json::Text("Infinity".to_string())
                } else if lowered == "nan" {
                    Json::Text("NaN".to_string())
                } else {
                    Json::Text(name)
                }
            }
        }
    }

    /// Consumes the remainder of a value without building it, used for limits.
    fn skip_to_end_of_value(&mut self) {
        let mut depth = 0i32;
        while let Some(character) = self.peek() {
            self.position += 1;
            match character {
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' => {
                    depth -= 1;
                    if depth <= 0 {
                        return;
                    }
                }
                ',' if depth == 0 => return,
                _ => {}
            }
        }
    }
}

fn json_key_name(key: &Json) -> String {
    match key {
        Json::Text(text) => text.clone(),
        Json::Number(number) => number.clone(),
        Json::Bool(value) => value.to_string(),
        Json::Null => "null".to_string(),
        _ => "<key>".to_string(),
    }
}

fn strip_numeric_suffix(raw: &str) -> String {
    let trimmed = raw.trim_end_matches(|character: char| character.is_ascii_alphabetic());
    if trimmed.is_empty() || trimmed.ends_with('e') || trimmed.ends_with('E') {
        return raw.to_string();
    }
    // Keep the digits when the suffix is a Rust primitive suffix such as `f64`.
    if trimmed.chars().all(|character| character.is_ascii_digit() || character == '.' || character == '-' || character == '+' || character == '_') {
        trimmed.to_string()
    } else {
        raw.to_string()
    }
}

fn is_numeric(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let mut seen_digit = false;
    let mut previous = ' ';
    for character in value.chars() {
        match character {
            '0'..='9' => seen_digit = true,
            '.' => {}
            '-' | '+' => {
                if previous != 'e' && previous != 'E' && previous != ' ' {
                    return false;
                }
            }
            'e' | 'E' => {}
            _ => return false,
        }
        previous = character;
    }
    seen_digit
}

fn write_envelope(value: &Json, out: &mut String, max_items: usize, max_depth: usize) {
    let (kind, total) = match value {
        Json::Array(elements) => ("sequence", Some(elements.len())),
        Json::Mapping(pairs) => ("mapping", Some(pairs.len())),
        _ => ("record", Some(1)),
    };

    out.push_str("{\"__ec\":1,\"kind\":");
    write_string(kind, out);
    out.push_str(",\"total\":");
    match total {
        Some(count) => out.push_str(&count.to_string()),
        None => out.push_str("null"),
    }
    out.push_str(",\"items\":[");

    match value {
        Json::Array(elements) => {
            for (index, element) in elements.iter().take(max_items).enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(element, out, max_depth.saturating_sub(1));
            }
        }
        Json::Mapping(pairs) => {
            for (index, (key, item)) in pairs.iter().take(max_items).enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push('[');
                write_value(key, out, 1);
                out.push(',');
                write_value(item, out, max_depth.saturating_sub(2));
                out.push(']');
            }
        }
        other => write_value(other, out, max_depth.saturating_sub(1)),
    }

    out.push_str("]}");
}

fn write_value(value: &Json, out: &mut String, depth: usize) {
    if depth == 0 {
        match value {
            Json::Array(elements) => {
                out.push_str("{\"len\":");
                out.push_str(&elements.len().to_string());
                out.push('}');
                return;
            }
            Json::Object(fields) => {
                out.push_str("{\"fields\":");
                out.push_str(&fields.len().to_string());
                out.push('}');
                return;
            }
            Json::Mapping(pairs) => {
                out.push_str("{\"entries\":");
                out.push_str(&pairs.len().to_string());
                out.push('}');
                return;
            }
            _ => {}
        }
    }

    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Json::Number(number) => out.push_str(number),
        Json::Text(text) => write_string(text, out),
        Json::Array(elements) => {
            out.push('[');
            for (index, element) in elements.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(element, out, depth.saturating_sub(1));
            }
            out.push(']');
        }
        Json::Object(fields) => {
            out.push('{');
            for (index, (name, field)) in fields.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(name, out);
                out.push(':');
                write_value(field, out, depth.saturating_sub(1));
            }
            out.push('}');
        }
        Json::Mapping(pairs) => {
            out.push('{');
            for (index, (key, item)) in pairs.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(&json_key_name(key), out);
                out.push(':');
                write_value(item, out, depth.saturating_sub(1));
            }
            out.push('}');
        }
    }
}

fn write_string(value: &str, out: &mut String) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            other if (other as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", other as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}
