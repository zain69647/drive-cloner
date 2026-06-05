Here is a complete, professional `README.md` file ready for your GitHub repository. It highlights the advanced engineering of the app (like bypassing the 6-minute limit) and provides foolproof instructions for anyone visiting your repo to deploy it themselves.

You can copy and paste this directly into your GitHub repository!

---

# 📂 Google Drive Folder Cloner

A powerful, resilient, and fully free web application built with Google Apps Script (GAS) that allows users to clone massive Google Drive folders without hitting execution timeouts.

Standard Google Apps Scripts die after 6 minutes. This cloner uses an advanced **Chunk-Processing Engine**, **Time-Driven Triggers**, and **Just-In-Time Indexing** to bypass execution limits, intelligently pause itself, and resume exactly where it left off until the clone is 100% complete.

## ✨ Key Features

* **Bypasses Google's 6-Minute Limit:** Automatically saves state and sets resume triggers to clone folders of any size.
* **Smart Memory Management:** Uses Just-In-Time indexing to keep RAM usage flat, preventing crashes on folders with thousands of files.
* **Duplicate Prevention:** Scans the destination folder in bulk to skip existing files and save API quota.
* **Beautiful, Responsive UI:** Features a clean interface with a live progress bar, detailed statistics, and a built-in Dark Mode.
* **Privacy-First Architecture:** Executes entirely within the user's own Google Account. No data is ever sent to third-party servers.

---

## 🚀 How to Deploy (Step-by-Step)

Because this runs on Google Apps Script, you don't need a server or hosting provider. Follow these steps to deploy your own private instance in less than 5 minutes.

### Step 1: Create the Project

1. Go to [script.google.com](https://script.google.com/) and click **New project**.
2. Rename the project at the top left to something like `Drive Cloner`.

### Step 2: Enable the Drive API

1. On the left sidebar, click the **`+`** icon next to **Services**.
2. Scroll down and select **Google Drive API**.
3. Leave the version as `v3` and the identifier as `Drive`. Click **Add**.

### Step 3: Add the Code

You need to copy the three files from this repository into your Apps Script project.

1. **`Code.gs`**: Delete the default code in the editor and paste the contents of `Code.gs` from this repo.
2. **`Index.html`**:
* Click the **`+`** icon next to **Files** on the left sidebar and select **HTML**.
* Name it exactly `Index` (capital I).
* Paste the contents of `Index.html` into this file.


3. **`appsscript.json` (Manifest)**:
* Click the **Project Settings** (gear icon ⚙️) on the left sidebar.
* Check the box that says **"Show 'appsscript.json' manifest file in editor"**.
* Go back to the Editor (`< >` icon), click on `appsscript.json`, and replace its contents with the JSON file from this repo.



### Step 4: Deploy the Web App

1. Click the blue **Deploy** button in the top right corner and select **New deployment**.
2. Click the gear icon (⚙️) next to "Select type" and choose **Web app**.
3. Configure the settings **exactly** like this for security:
* **Description:** Drive Cloner v1
* **Execute as:** `User accessing the web app` *(Crucial: This ensures it uses the visitor's Google account, not yours!)*
* **Who has access:** `Anyone`


4. Click **Deploy**.
5. Click **Authorize access**, choose your Google Account, click **Advanced**, and proceed to the app.
6. Copy your live **Web app URL**. You're done!

---

## 🛠️ How to Use

1. Open your live Web App URL.
2. Paste the **Source Folder URL** (the folder you want to copy). Ensure you have at least "Viewer" permissions for this folder.
3. Paste the **Destination Folder URL** (an empty folder where you want the files to go). Ensure you have "Editor" permissions here.
4. Click **Analyze Folders**. The app will calculate the total files, subfolders, and estimated size.
5. Click **Start Clone**.
6. You can safely leave the tab open. The UI will poll the server every few seconds to give you a live update on the background workers!

## ⚠️ Limitations & Notes

* Google imposes daily quotas on copying files (usually around 750GB to 1TB per day per user). If you hit this Google-level limit, the script will throw an error and you will need to wait 24 hours to resume.
* Very large folders (50GB+) may take a minute or two just to run the initial analysis. Be patient!
