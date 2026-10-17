//! Checks for the Rust helper module.
//!
//! Run with:  cargo test

mod support;

use exploring_collections_helper::{describe, dump_json, dump_json_with_limits};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use support::{parse, Value};

#[derive(Debug)]
struct Temperature {
    city: String,
    degree_celsius: i64,
    date: String,
}

#[derive(Debug)]
enum Weather {
    Cold,
    Warm(i64),
    Detailed { city: String, degree: i64 },
}

#[derive(Debug)]
struct Node {
    name: String,
    next: Option<Box<Node>>,
}

#[test]
fn sequence_of_structs() {
    let temperatures = vec![
        Temperature {
            city: "Seoul".to_string(),
            degree_celsius: 21,
            date: "2024-04-01".to_string(),
        },
        Temperature {
            city: "Lima".to_string(),
            degree_celsius: 19,
            date: "2024-04-02".to_string(),
        },
    ];

    let payload = dump_json(&temperatures);
    let parsed = parse(&payload);
    assert_eq!(parsed.get("__ec").and_then(Value::number), Some(1.0), "{payload}");
    assert_eq!(parsed.get("kind").and_then(Value::text), Some("sequence"));
    assert_eq!(parsed.get("total").and_then(Value::number), Some(2.0));

    let items = parsed.get("items").and_then(Value::array).expect("items");
    let first = &items[0];
    assert_eq!(first.get("city").and_then(Value::text), Some("Seoul"), "{payload}");
    assert_eq!(first.get("degree_celsius").and_then(Value::number), Some(21.0));
    assert_eq!(first.get("date").and_then(Value::text), Some("2024-04-01"));
}

#[test]
fn mapping_from_hashmap() {
    let mut map: HashMap<String, i64> = HashMap::new();
    map.insert("Seoul".to_string(), 21);

    let payload = dump_json(&map);
    let parsed = parse(&payload);
    assert_eq!(parsed.get("kind").and_then(Value::text), Some("mapping"), "{payload}");
    assert_eq!(parsed.get("total").and_then(Value::number), Some(1.0));

    let items = parsed.get("items").and_then(Value::array).expect("items");
    let pair = items[0].array().expect("pair");
    assert_eq!(pair[0].text(), Some("Seoul"), "{payload}");
    assert_eq!(pair[1].number(), Some(21.0));
}

#[test]
fn mapping_from_btreemap_is_ordered() {
    let mut map: BTreeMap<i64, &str> = BTreeMap::new();
    map.insert(2, "b");
    map.insert(1, "a");

    let payload = dump_json(&map);
    let parsed = parse(&payload);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].array().expect("pair")[0].number(), Some(1.0), "{payload}");
}

#[test]
fn record_mode_for_a_single_struct() {
    let payload = dump_json(&Temperature {
        city: "Seoul".to_string(),
        degree_celsius: 21,
        date: "2024-04-01".to_string(),
    });
    let parsed = parse(&payload);
    assert_eq!(parsed.get("kind").and_then(Value::text), Some("record"), "{payload}");
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].get("city").and_then(Value::text), Some("Seoul"));
}

#[test]
fn primitives_and_special_floats() {
    let payload = dump_json(&vec![1, 2, 3]);
    let parsed = parse(&payload);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].number(), Some(1.0), "{payload}");

    let payload = dump_json(&vec![f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1.5]);
    let parsed = parse(&payload);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].text(), Some("NaN"), "{payload}");
    assert_eq!(items[1].text(), Some("Infinity"));
    assert_eq!(items[2].text(), Some("-Infinity"));
    assert_eq!(items[3].number(), Some(1.5));
}

#[test]
fn nested_structures() {
    let payload = dump_json(&vec![vec![1, 2], vec![3]]);
    let parsed = parse(&payload);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].array().expect("inner").len(), 2, "{payload}");

    #[derive(Debug)]
    struct Outer {
        name: String,
        inner: Inner,
    }
    #[derive(Debug)]
    struct Inner {
        value: i64,
    }

    let payload = dump_json(&Outer {
        name: "outer".to_string(),
        inner: Inner { value: 7 },
    });
    let parsed = parse(&payload);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(
        items[0]
            .get("inner")
            .and_then(|value| value.get("value"))
            .and_then(Value::number),
        Some(7.0),
        "{payload}"
    );
}

#[test]
fn options_and_enums() {
    let some = dump_json(&Some(21));
    let parsed = parse(&some);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].number(), Some(21.0), "{some}");

    let none: Option<i64> = None;
    let none_payload = dump_json(&none);
    let parsed = parse(&none_payload);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert!(matches!(items[0], Value::Null), "{none_payload}");

    let cold = dump_json(&Weather::Cold);
    let parsed = parse(&cold);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].text(), Some("Cold"), "{cold}");

    let warm = dump_json(&Weather::Warm(21));
    let parsed = parse(&warm);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].get("Case").and_then(Value::text), Some("Warm"), "{warm}");
    assert_eq!(items[0].get("0").and_then(Value::number), Some(21.0), "{warm}");

    let detailed = dump_json(&Weather::Detailed {
        city: "Seoul".to_string(),
        degree: 21,
    });
    let parsed = parse(&detailed);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].get("city").and_then(Value::text), Some("Seoul"), "{detailed}");
}

#[test]
fn nested_structures_are_bounded() {
    let node = Node {
        name: "root".to_string(),
        next: Some(Box::new(Node {
            name: "child".to_string(),
            next: None,
        })),
    };

    let payload = dump_json(&node);
    assert!(payload.len() < 20_000, "payload too large: {}", payload.len());
    let parsed = parse(&payload);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].get("name").and_then(Value::text), Some("root"));
}

#[test]
fn deeply_nested_values_stay_bounded() {
    #[derive(Debug)]
    struct Recursive {
        label: String,
        child: Option<Box<Recursive>>,
    }

    let mut root = Recursive {
        label: "0".to_string(),
        child: None,
    };
    for index in 1..40 {
        root = Recursive {
            label: index.to_string(),
            child: Some(Box::new(root)),
        };
    }

    let payload = dump_json(&root);
    assert!(payload.len() < 60_000, "payload too large: {}", payload.len());
    let parsed = parse(&payload);
    assert_eq!(parsed.get("kind").and_then(Value::text), Some("record"));
}

#[test]
fn limits_are_respected() {
    let many: Vec<i64> = (0..500).collect();
    let parsed = parse(&dump_json_with_limits(&many, 4, 10));
    assert_eq!(parsed.get("total").and_then(Value::number), Some(500.0));
    assert_eq!(
        parsed.get("items").and_then(Value::array).map(|items| items.len()),
        Some(10)
    );

    let parsed = parse(&dump_json_with_limits(&many, 0, 0));
    assert_eq!(parsed.get("total").and_then(Value::number), Some(500.0));
}

#[test]
fn strings_are_escaped_correctly() {
    let values = vec![
        "quote\"backslash\\newline\n\ttab".to_string(),
        "üñïçødé".to_string(),
        "emoji 🎉".to_string(),
        String::new(),
    ];

    let payload = dump_json(&values);
    let parsed = parse(&payload);
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].text(), Some("quote\"backslash\\newline\n\ttab"), "{payload}");
    assert_eq!(items[1].text(), Some("üñïçødé"));
    assert_eq!(items[2].text(), Some("emoji 🎉"));
    assert_eq!(items[3].text(), Some(""));
}

#[test]
fn tuples_and_sets() {
    let payload = dump_json(&(1, "two"));
    let parsed = parse(&payload);
    assert_eq!(parsed.get("kind").and_then(Value::text), Some("sequence"), "{payload}");
    let items = parsed.get("items").and_then(Value::array).expect("items");
    assert_eq!(items[0].number(), Some(1.0));
    assert_eq!(items[1].text(), Some("two"));

    let set: BTreeSet<i64> = [1, 2, 3].into_iter().collect();
    let payload = dump_json(&set);
    let parsed = parse(&payload);
    assert_eq!(parsed.get("kind").and_then(Value::text), Some("sequence"), "{payload}");
}

#[test]
fn describe_reports_a_preview() {
    assert_eq!(describe(&vec![1, 2, 3]), "[1, 2, 3]");
    let long = "x".repeat(200);
    let described = describe(&long);
    assert!(described.chars().count() <= 120, "{}", described.chars().count());
    assert!(described.ends_with('…'));
}
