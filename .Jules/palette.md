## 2024-05-18 - Adding Accessible Loading States to Buttons
**Learning:** Applying `aria-busy="true"` to buttons during asynchronous operations correctly communicates the loading state to assistive technologies.
**Action:** Use `aria-busy` in combination with disabling the button when providing visual loading feedback on any async interaction.
## 2024-11-01 - Adding aria-required to Required Form Fields
**Learning:** While the HTML5 `required` attribute provides client-side validation, adding `aria-required="true"` explicitly communicates to assistive technologies that a field is mandatory, enhancing the accessibility and user experience for screen reader users.
**Action:** Always pair the `required` attribute with `aria-required="true"` on form fields such as `<input>`, `<select>`, and `<textarea>`.
