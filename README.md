# Ligma

Chrome extension to annotate any page element, capture feedback with screenshots, and send to Linear.

## Installation

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the project folder

No build step required — the repo includes the fully built extension.

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
