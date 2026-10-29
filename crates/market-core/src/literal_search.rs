//! Literal display filtering shared by native and CLI snapshots.
//!
//! Mirrors the web's word-boundary phrase match, then reordered keyword AND.
//! This is spelling-based matching, without topic expansion, stemming or fuzzy
//! guesses. Unicode lowercase and alphanumeric boundaries use only `std`.
//! Unlike the web's NFKC pass, compatibility and canonical Unicode forms are not
//! normalized here (for example, full-width Latin and decomposed accents).

use std::collections::HashSet;

fn normalize(text: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for character in text.to_lowercase().chars() {
        if character.is_alphanumeric() {
            if separator && !result.is_empty() {
                result.push(' ');
            }
            result.push(character);
            separator = false;
        } else {
            separator = true;
        }
    }
    result
}

fn is_stop_word(word: &str) -> bool {
    matches!(
        word,
        "a" | "an"
            | "the"
            | "and"
            | "or"
            | "for"
            | "with"
            | "to"
            | "in"
            | "on"
            | "at"
            | "of"
            | "from"
            | "by"
            | "my"
            | "i"
            | "want"
            | "looking"
            | "find"
            | "show"
            | "please"
    )
}

pub fn matches_literal_search(text: &str, query: &str) -> bool {
    let phrase = normalize(query);
    if phrase.is_empty() {
        return true;
    }
    let haystack = normalize(text);
    if format!(" {haystack} ").contains(&format!(" {phrase} ")) {
        return true;
    }
    let available: HashSet<_> = haystack.split_whitespace().collect();
    let mut words = phrase.split_whitespace().filter(|word| !is_stop_word(word));
    let Some(first) = words.next() else {
        return false;
    };
    available.contains(first) && words.all(|word| available.contains(word))
}

#[cfg(test)]
mod tests {
    use super::matches_literal_search as matches;

    #[test]
    fn reordered_words_can_span_listing_fields() {
        let fields = [
            "Bicycle",
            "Bright red frame",
            "transport",
            "vintage",
            "Helsinki",
        ];
        assert!(matches(&fields.join(" "), "red bicycle vintage Helsinki"));
        assert!(!matches(&fields.join(" "), "red bicycle vintage Tampere"));
    }

    #[test]
    fn words_do_not_match_inside_other_words() {
        assert!(!matches("steak", "tea"));
        assert!(!matches("carpet", "car"));
        assert!(!matches("breadboard", "bread board"));
        assert!(!matches("AB12", "12"));
        assert!(matches("Green tea and a car", "tea car"));
    }

    #[test]
    fn punctuation_and_hyphens_are_word_boundaries() {
        assert!(matches("T-Shirt", "t shirt"));
        assert!(matches("T_Shirt", "T-SHIRT"));
        assert!(matches("Red, city bicycle!", "bicycle / red"));
        assert!(matches("women's winter boots", "winter women's boots"));
    }

    #[test]
    fn unicode_lowercase_preserves_finnish_letters() {
        assert!(matches("Helsinki: TUORE LEIPÄ", "leipä tuore"));
        assert!(matches("KÄYTETTY PYÖRÄ", "pyörä käytetty"));
        assert!(!matches("LEIPÄ", "leipa"));
    }

    #[test]
    fn grammatical_stop_words_match_web_without_becoming_semantic_expansion() {
        assert!(matches("Bright red bicycle", "I want a red bicycle please"));
        assert!(!matches("Bright red bicycle", "the and"));
        assert!(matches("The and or labels", "the and"));
        assert!(!matches("Beef steaks", "human edible products"));
        assert!(!matches("Fresh bread", "food"));
        assert!(!matches("Used phone", "electronics"));
        assert!(!matches("Bicycle", "bicyle"));
    }

    #[test]
    fn empty_or_punctuation_only_queries_do_not_filter() {
        for query in ["", " \n\t ", "---"] {
            assert!(matches("Anything", query));
        }
        assert!(!matches("", "bicycle"));
    }

    #[test]
    fn unicode_normalization_gap_is_explicit() {
        assert!(!matches("FRESH bread", "ＦＲＥＳＨ bread"));
        assert!(!matches("Café", "Cafe\u{301}"));
    }
}
