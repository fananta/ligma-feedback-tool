# Ligma

Chrome extension to annotate any page element, capture feedback with screenshots, and send to Linear.

## Installation

1. [**Download ligma-feedback-tool.zip**](https://github.com/fananta/ligma-feedback-tool/releases/latest/download/ligma-feedback-tool.zip)
2. Unzip the file
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (top right toggle)
5. Click **Load unpacked** and select the `ligma-feedback-tool` folder

No build step required.

## Setup

1. Click the Ligma extension icon on any page to activate annotation mode
2. Click the **⚙️ Settings** button in the toolbar
3. Paste your Linear API key (starts with `lin_api_`)
4. Select your Team, Project, and Label from the dropdowns
5. Status dot turns green when fully configured

## Usage

- **Toggle annotation mode** — click the extension icon in the browser toolbar
- **Annotate** — click any element on the page, type your feedback
- **Delete** — hover over a marker and click the trash icon
- **Copy** — copies all annotations to clipboard as rich HTML with screenshots
- **Send** — creates a Linear issue for each annotation with cropped screenshots

## Development

Install dependencies and use watch mode for automatic rebuilds:

```
npm install
npm run dev
```
