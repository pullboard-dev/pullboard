pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::add;

    #[test]
    fn adds() {
        assert_eq!(add(1, 2), 3);
    }

    #[cfg(feature = "fails")]
    #[test]
    fn broken() {
        assert_eq!(add(1, 2), 4);
    }
}
