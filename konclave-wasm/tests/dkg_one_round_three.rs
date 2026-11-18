// One round 3 for every DKG a device runs. ZIP 312's key negation happens inside FROST's `part3`
// (an odd raw group key becomes -PK, every -sk_i and every -PK_i), and `dkg_even_y.rs` checks it on
// `dkg::part3_wire`. The app's creation (`creation::Creation`) called `part3` itself, with its own
// copy of the deserialisation around it. It negated too, since it ran the same FROST function; what
// it lacked was a test reading the path the app takes. It now goes through `part3_wire`, and this
// scan keeps it that way: a second caller of `part3` would be a second implementation of round 3
// that the negation test never reads.
//
// The scan counts the TOKEN `part3`, not a call shape, so an alias (`use .. part3 as p3`), a
// function pointer (`let f = part3`), a turbofish or a space before the parenthesis is still seen.
// The only places it may appear are the `use` and the call inside `pub mod dkg`. Comments and the
// contents of strings are stripped, and a `//` inside a string does not hide what follows it.

/// `src` with every `//` comment and the contents of every string literal removed (a string names
/// nothing it could call), char literals kept intact.
fn code_only(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            if c == '\\' {
                chars.next();
            } else if c == '"' {
                out.push(c);
                in_str = false;
            }
            continue;
        }
        match c {
            // A char literal ('"', '\\', '\''): copied whole, so its quote does not open a string.
            // A lifetime ('a) has no closing quote within three characters and is copied as is.
            '\'' => {
                out.push(c);
                let ahead: Vec<char> = chars.clone().take(3).collect();
                let len = match ahead.as_slice() {
                    ['\\', _, '\'', ..] => 3,
                    [_, '\'', ..] => 2,
                    _ => 0,
                };
                for _ in 0..len {
                    out.push(chars.next().expect("peeked"));
                }
            }
            '"' => {
                in_str = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Every place the bare name `part3` is used in `code`: the whole identifier, not a method call
/// (`.part3`, the JS session's own round 3, which calls `part3_wire`) and not a definition (`fn part3`).
fn part3_uses(code: &str) -> Vec<usize> {
    let bytes = code.as_bytes();
    let mut at = Vec::new();
    let mut from = 0;
    while let Some(i) = code[from..].find("part3") {
        let i = from + i;
        let end = i + "part3".len();
        let prev = if i == 0 { b' ' } else { bytes[i - 1] };
        let next = bytes.get(end).copied().unwrap_or(b' ');
        let whole = !is_ident(prev) && !is_ident(next);
        let defined = code[..i].trim_end().ends_with("fn");
        if whole && prev != b'.' && !defined {
            at.push(i);
        }
        from = end;
    }
    at
}

/// The span of `pub mod dkg { .. }`: from its line to the next top-level `pub mod`.
fn dkg_module(code: &str) -> (usize, usize) {
    let start = code.find("\npub mod dkg {").expect("pub mod dkg exists");
    let end = code[start + 1..]
        .find("\npub mod ")
        .map(|i| start + 1 + i)
        .unwrap_or(code.len());
    (start, end)
}

#[test]
fn only_part3_wire_runs_round_three() {
    let code = code_only(include_str!("../src/lib.rs"));
    let uses = part3_uses(&code);
    let (start, end) = dkg_module(&code);
    let outside: Vec<usize> = uses
        .iter()
        .copied()
        .filter(|&i| i < start || i >= end)
        .collect();
    assert!(
        outside.is_empty(),
        "FROST's part3 is named outside pub mod dkg at byte offsets {outside:?}: round 3 belongs to dkg::part3_wire"
    );
    assert_eq!(
        uses.len(),
        2,
        "inside pub mod dkg, part3 appears twice: its `use` and the call in part3_wire"
    );
    let wire = code
        .find("pub fn part3_wire(")
        .expect("dkg::part3_wire exists");
    let call = uses[1];
    let wire_end = code[wire..]
        .find("\n    }\n")
        .map(|i| wire + i)
        .expect("part3_wire ends");
    assert!(
        call > wire && call < wire_end,
        "the call of part3 is inside dkg::part3_wire"
    );
}

#[test]
fn the_scan_finds_every_planted_second_use() {
    let planted = [
        "fn other() { let x = part3(s, &r1, &r2); }",
        "fn other() { let x = part3 (s, &r1, &r2); }",
        "fn other() { let x = frost_core::keys::dkg::part3::<C>(s, &r1, &r2); }",
        "use frost::keys::dkg::part3 as p3;",
        "fn other() { let f = part3; }",
        "fn other() { let s = \"a // b\"; let x = part3(s); }",
        "fn other() { let q = '\"'; let x = part3(q); }",
    ];
    for p in planted {
        assert_eq!(part3_uses(&code_only(p)).len(), 1, "missed: {p}");
    }
    let not_uses = [
        "// part3(in a comment)",
        "fn y() { repair_share_part3(a) }",
        "pub fn part3(&mut self) { s.part3(); dkg::part3_wire(x) }",
        "let s = \"part3_wire\";",
    ];
    for p in not_uses {
        assert_eq!(part3_uses(&code_only(p)).len(), 0, "counted: {p}");
    }
}
