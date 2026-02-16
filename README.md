# Ligma

Chrome extension to annotate any page element, capture feedback with screenshots, and send to Linear.

## Installation

1. Clone the repo
2. Install dependencies:
   ```
   npm install
   ```
3. Build the content script:
   ```
   npm run build
   ```
4. Open `chrome://extensions` in Chrome
5. Enable **Developer mode** (top right toggle)
6. Click **Load unpacked** and select the project folder

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

Watch mode for automatic rebuilds:

```
npm run dev
```
