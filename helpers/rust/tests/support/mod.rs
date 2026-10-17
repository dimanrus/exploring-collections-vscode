//! Minimal JSON reader used by the tests, so the helper package stays
//! dependency free (the helper itself must not pull in external crates either).

#![allow(dead_code)]

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(entries) => entries
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn text(&self) -> Option<&str> {
        match self {
            Value::Text(text) => Some(text),
            _ => None,
        }
    }

    pub fn number(&self) -> Option<f64> {
        match self {
            Value::Number(number) => Some(*number),
            _ => None,
        }
    }

    pub fn array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Array(values) => Some(values),
            _ => None,
        }
    }
}

pub fn parse(input: &str) -> Value {
    let chars: Vec<char> = input.chars().collect();
    let mut position = 0usize;
    parse_value(&chars, &mut position)
}

fn skip(chars: &[char], position: &mut usize) {
    while let Some(character) = chars.get(*position) {
        if character.is_whitespace() {
            *position += 1;
        } else {
            break;
        }
    }
}

fn parse_value(chars: &[char], position: &mut usize) -> Value {
    skip(chars, position);
    match chars.get(*position) {
        None => Value::Null,
        Some('"') => Value::Text(parse_string(chars, position)),
        Some('[') => {
            *position += 1;
            let mut values = Vec::new();
            loop {
                skip(chars, position);
                if chars.get(*position) == Some(&']') {
                    *position += 1;
                    break;
                }
                if chars.get(*position).is_none() {
                    break;
                }
                values.push(parse_value(chars, position));
                skip(chars, position);
                if chars.get(*position) == Some(&',') {
                    *position += 1;
                }
            }
            Value::Array(values)
        }
        Some('{') => {
            *position += 1;
            let mut entries = Vec::new();
            loop {
                skip(chars, position);
                if chars.get(*position) == Some(&'}') {
                    *position += 1;
                    break;
                }
                if chars.get(*position).is_none() {
                    break;
                }
                let key = parse_string(chars, position);
                skip(chars, position);
                if chars.get(*position) == Some(&':') {
                    *position += 1;
                }
                entries.push((key, parse_value(chars, position)));
                skip(chars, position);
                if chars.get(*position) == Some(&',') {
                    *position += 1;
                }
            }
            Value::Object(entries)
        }
        Some('t') => {
            *position += 4;
            Value::Bool(true)
        }
        Some('f') => {
            *position += 5;
            Value::Bool(false)
        }
        Some('n') => {
            *position += 4;
            Value::Null
        }
        Some(_) => {
            let start = *position;
            while let Some(character) = chars.get(*position) {
                let is_number_character = character.is_ascii_digit()
                    || *character == '-'
                    || *character == '+'
                    || *character == '.'
                    || *character == 'e'
                    || *character == 'E';
                if is_number_character {
                    *position += 1;
                } else {
                    break;
                }
            }
            let text: String = chars[start..*position].iter().collect();
            Value::Number(text.parse().unwrap_or(f64::NAN))
        }
    }
}

fn parse_string(chars: &[char], position: &mut usize) -> String {
    if chars.get(*position) != Some(&'"') {
        return String::new();
    }
    *position += 1;
    let mut result = String::new();
    while let Some(character) = chars.get(*position) {
        *position += 1;
        match character {
            '"' => break,
            '\\' => {
                if let Some(escape) = chars.get(*position) {
                    *position += 1;
                    match escape {
                        'n' => result.push('\n'),
                        'r' => result.push('\r'),
                        't' => result.push('\t'),
                        'b' => result.push('\u{08}'),
                        'f' => result.push('\u{0c}'),
                        'u' => {
                            let hex: String = chars[*position..(*position + 4).min(chars.len())]
                                .iter()
                                .collect();
                            *position += 4;
                            if let Ok(code) = u32::from_str_radix(&hex, 16) {
                                if let Some(decoded) = char::from_u32(code) {
                                    result.push(decoded);
                                }
                            }
                        }
                        other => result.push(*other),
                    }
                }
            }
            other => result.push(*other),
        }
    }
    result
}
