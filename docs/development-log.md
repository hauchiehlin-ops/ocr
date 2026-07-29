# Development Log

## 2026-07-29

- Refined the right-side inspector so selected text blocks now show a live format summary, including font family, size, weight, style, and fill color.
- Changed text formatting controls to immediate-apply behavior for selected text blocks. Color, font family, font size, bold, and italic now update the current selection directly instead of depending on separate apply buttons.
- Removed the now-obsolete preset apply checkboxes from the font settings panel and cleaned the related UI logic.
- Simplified the text formatting workflow by keeping copy/apply-copied-format actions while removing redundant apply-step interactions.
- Updated color preset behavior so built-in colors stay first, custom picker colors are appended after them, and the visible list keeps at most 10 colors by rotating out the oldest custom entries.
- Adjusted Traditional Chinese, Simplified Chinese, and English UI wording to match the new inspector behavior.
- Moved the “Run OCR automatically after loading an image” toggle to the very top of the right-side inspector so the OCR entry behavior is visible before deeper engine settings.
- Updated the user manual wording to reflect the new top-of-inspector location for the automatic OCR toggle.
