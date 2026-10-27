## 2024-05-19 - Adding form tags significantly improves accessibility
**Learning:** Wrapping input fields inside a semantic `<form>` tag and converting the submission action to `<button type="submit">` enables out-of-the-box keyboard support, including submitting via the 'Enter' key, without requiring complex keydown event listeners.
**Action:** Always prefer semantic HTML tags over `<div>` wrappers for interactive sections that take user input.
