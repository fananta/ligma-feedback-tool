# Ligma

Chrome extension to annotate any page element, capture feedback with screenshots, and send to Linear.

## Installation

1. [**Download ligma-feedback-tool.zip**](https://github.com/fananta/ligma-feedback-tool/releases/latest/download/ligma-feedback-tool.zip)
2. Unzip the file
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (top right toggle)
5. Click **Load unpacked** and select the `ligma-feedback-tool` folder

No build step required.

### Updating the Extension

1. [**Download ligma-feedback-tool.zip**](https://github.com/fananta/ligma-feedback-tool/releases/latest/download/ligma-feedback-tool.zip)
2. Unzip the file
3. Ensure it's in the same directory as the past version. Replace the old folder and rename to exact same name (`ligma-feedback-tool`).
4. Open `chrome://extensions` in Chrome
5. **Reload** the extension with the reload button. Do not use load unpacked again.
<img width="411" height="228" alt="image" src="https://github.com/user-attachments/assets/f9849d27-975d-4e26-a82e-95cdcb3df3a9" />

## Setup

1. Click the Ligma extension icon on any page to activate annotation mode
2. Click the **⚙️ Settings** button in the toolbar
3. Paste your Linear API key (`Linear > Settings > Security & access > Personal API keys`)
4. Select your Team, Project, and Label from the dropdowns
5. Status dot turns green when fully configured

## Usage

- **Toggle annotation mode** — click the extension icon in the browser toolbar
- **Annotate** — click any element on the page, type your feedback
- **Delete** — hover over a marker and click the trash icon
- **Copy** — copies all annotations to clipboard as rich HTML with screenshots
- **Send** — creates a Linear issue for each annotation with cropped screenshots
