/**
 * Serves the HTML file when a user visits the Web App URL.
 */
function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Drive Folder Cloner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Helper function to include external files (CSS/JS) into the main HTML.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Extracts folder ID from a Google Drive folder URL
 * @param {string} url 
 * @returns {string} folder ID
 * @throws Error if no valid ID found
 */
function extractFolderId(url) {
  const match = url.match(/[-\w]{25,}/);
  if (match) return match[0];
  throw new Error('Invalid Google Drive Folder URL. Please provide a complete folder link.');
}

/**
 * Validates that the current user can access the folder
 * @param {string} folderId 
 * @param {boolean} isSource 
 */
function validateFolderAccess(folderId, isSource = true) {
  try {
    DriveApp.getFolderById(folderId);
  } catch (e) {
    const type = isSource ? 'source' : 'destination';
    throw new Error(`Cannot access the ${type} folder. Check permissions and URL.`);
  }
}

/**
 * Get folder name safely
 * @param {string} folderId 
 * @returns {string}
 */
function getFolderName(folderId) {
  try {
    return DriveApp.getFolderById(folderId).getName();
  } catch (e) {
    throw new Error('Cannot retrieve folder name.');
  }
}

/**
 * Convert bytes → MB and GB with sensible precision
 * @param {number} bytes 
 * @returns {{mb: string, gb: string}}
 */
function formatSize(bytes) {
  const mb = (bytes / (1024 * 1024)).toFixed(2);
  const gb = (bytes / (1024 * 1024 * 1024)).toFixed(4);
  return { mb, gb };
}

/**
 * Analyze source folder structure & size (non-recursive deep traversal)
 * @param {string} sourceUrl 
 * @returns {{stats: Object, sourceName: string}}
 */
function analyzeFolder(sourceUrl) {
  const sourceId = extractFolderId(sourceUrl);
  validateFolderAccess(sourceId, true);
  const sourceName = getFolderName(sourceId);

  const stats = {
    totalFiles: 0,
    totalFolders: 0,
    images: 0,
    videos: 0,
    documents: 0,
    totalSizeBytes: 0,
    warning: false,
    message: ''
  };

  const queue = [sourceId];

  while (queue.length > 0) {
    const currentId = queue.shift();

    // Subfolders
    let pageToken = null;
    do {
      const res = Drive.Files.list({
        q: `'${currentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'nextPageToken, files(id)',
        pageToken,
        pageSize: 1000
      });

      if (res.files) {
        res.files.forEach(f => {
          queue.push(f.id);
          stats.totalFolders++;
        });
      }
      pageToken = res.nextPageToken;
    } while (pageToken);

    // Files
    pageToken = null;
    do {
      const res = Drive.Files.list({
        q: `'${currentId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'nextPageToken, files(id, mimeType, size)',
        pageToken,
        pageSize: 1000
      });

      if (res.files) {
        res.files.forEach(file => {
          stats.totalFiles++;
          if (file.size) stats.totalSizeBytes += Number(file.size);

          const mime = file.mimeType.toLowerCase();
          if      (mime.startsWith('image/'))  stats.images++;
          else if (mime.startsWith('video/'))  stats.videos++;
          else if (mime.includes('document') || mime === 'application/pdf' ||
                   mime.startsWith('text/') || mime.includes('wordprocessingml')) {
            stats.documents++;
          }
        });
      }
      pageToken = res.nextPageToken;
    } while (pageToken);
  }

  const sizes = formatSize(stats.totalSizeBytes);
  stats.totalSizeMB = sizes.mb;
  stats.totalSizeGB = sizes.gb;

  const totalItems = stats.totalFiles + stats.totalFolders;
  if (Number(stats.totalSizeGB) > 5 || totalItems > 1000) {
    stats.warning = true;
    stats.message = totalItems > 1000 
      ? `Large folder (${totalItems}+ items). May take significant time or hit execution limits.`
      : `Large size detected (${stats.totalSizeGB} GB). Cloning may be slow.`;
  }

  return { stats, sourceName };
}

/**
 * Initialize cloning state - NOW CREATES THE ROOT FOLDER WITH THE SAME NAME
 */
function startCloning(sourceUrl, destUrl, totalItems) {
  const sourceId = extractFolderId(sourceUrl);
  const destId   = extractFolderId(destUrl);

  validateFolderAccess(sourceId, true);
  validateFolderAccess(destId, false);

  const sourceName = getFolderName(sourceId);
  const destName   = getFolderName(destId);

  // Check if folder with the same name already exists in destination
  let targetFolderId = null;
  try {
    const safeName = sourceName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const query = `'${destId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const result = Drive.Files.list({
      q: query,
      fields: 'files(id)',
      pageSize: 1
    });

    if (result.files && result.files.length > 0) {
      targetFolderId = result.files[0].id;
      // You could add logic here to rename with (1), (2), etc. if you want
    }
  } catch (e) {
    console.error("Error checking for existing folder name", e);
  }

  // Create new folder if it doesn't exist
  if (!targetFolderId) {
    try {
      const newFolder = Drive.Files.create({
        name: sourceName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [destId]
      });
      targetFolderId = newFolder.id;
    } catch (e) {
      throw new Error(`Failed to create root folder "${sourceName}" in destination: ${e.message}`);
    }
  }

  // Now queue the CONTENTS of the source folder → new target folder
  const state = {
    pendingFolders: [{ sourceId: sourceId, destId: targetFolderId }],
    currentPhase: 'FILES',
    pageToken: null,
    processedCount: 0,
    totalItems,
    status: 'RUNNING',
    startTime: Date.now(),
    sourceName: sourceName,
    destName:   destName + " → " + sourceName   // nicer display in UI
  };

  PropertiesService.getUserProperties().setProperty('CLONE_STATE', JSON.stringify(state));
  deleteTriggers();

  return true;
}

/**
 * Get current cloning progress/state
 */
function getCloneProgress() {
  const stateStr = PropertiesService.getUserProperties().getProperty('CLONE_STATE');
  if (!stateStr) return { status: 'ERROR', message: 'No active cloning job.' };
  return JSON.parse(stateStr);
}

/**
 * Core chunk processor (time-boxed)
 */
function processChunk() {
  const MAX_TIME_MS = 4 * 60 * 1000; // 4 min safety
  const start = Date.now();

  const props = PropertiesService.getUserProperties();
  let stateStr = props.getProperty('CLONE_STATE');
  if (!stateStr) return { status: 'ERROR', message: 'State missing' };

  let state = JSON.parse(stateStr);
  if (state.status === 'COMPLETED') return state;

  while (state.pendingFolders.length > 0 && Date.now() - start < MAX_TIME_MS) {
    const curr = state.pendingFolders[0];

    // Build set of existing names in destination (fast deduplication)
    const existing = {};
    let token = null;
    do {
      const res = Drive.Files.list({
        q: `'${curr.destId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(name)',
        pageToken: token,
        pageSize: 1000
      });
      res.files?.forEach(f => existing[f.name] = true);
      token = res.nextPageToken;
    } while (token);

    // ── Phase: Copy Files ───────────────────────────────────────
    if (state.currentPhase === 'FILES') {
      try {
        const q = `'${curr.sourceId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
        const res = Drive.Files.list({
          q,
          pageToken: state.pageToken,
          pageSize: 50,
          fields: 'nextPageToken, files(id, name)'
        });

        res.files?.forEach(file => {
          if (!existing[file.name]) {
            try {
              Drive.Files.copy(
                { name: file.name, parents: [curr.destId] },
                file.id,
                { supportsAllDrives: true }
              );
            } catch (e) {
              console.error(`Copy failed: ${file.name}`, e);
            }
          }
          state.processedCount++;
        });

        state.pageToken = res.nextPageToken;
        if (!state.pageToken) state.currentPhase = 'FOLDERS';
      } catch (e) {
        console.error('Files phase error → skipping folder', e);
        state.pendingFolders.shift();
        state.currentPhase = 'FILES';
        state.pageToken = null;
      }
    }

    // ── Phase: Create Subfolders ─────────────────────────────────
    else if (state.currentPhase === 'FOLDERS') {
      try {
        const q = `'${curr.sourceId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const res = Drive.Files.list({
          q,
          pageToken: state.pageToken,
          pageSize: 50,
          fields: 'nextPageToken, files(id, name)'
        });

        res.files?.forEach(folder => {
          let newDestId = null;

          if (existing[folder.name]) {
            const safe = folder.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const check = Drive.Files.list({
              q: `'${curr.destId}' in parents and name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
              pageSize: 1
            });
            if (check.files?.length > 0) newDestId = check.files[0].id;
          }

          if (!newDestId) {
            try {
              const created = Drive.Files.create({
                name: folder.name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [curr.destId]
              });
              newDestId = created.id;
            } catch (e) {
              console.error(`Folder create failed: ${folder.name}`, e);
            }
          }

          state.processedCount++;
          if (newDestId) {
            state.pendingFolders.push({ sourceId: folder.id, destId: newDestId });
          }
        });

        state.pageToken = res.nextPageToken;
        if (!state.pageToken) {
          state.pendingFolders.shift();
          state.currentPhase = 'FILES';
        }
      } catch (e) {
        console.error('Folders phase error → skipping', e);
        state.pendingFolders.shift();
        state.currentPhase = 'FILES';
        state.pageToken = null;
      }
    }

    props.setProperty('CLONE_STATE', JSON.stringify(state));
  }

  // Still work left → schedule next run
  if (state.pendingFolders.length > 0) {
    props.setProperty('CLONE_STATE', JSON.stringify(state));
    setupTrigger();
  } else {
    state.status = 'COMPLETED';
    state.processedCount = state.totalItems;
    props.setProperty('CLONE_STATE', JSON.stringify(state));
    deleteTriggers();
  }

  return state;
}

/**
 * Create 1-minute trigger to continue work
 */
function setupTrigger() {
  deleteTriggers();
  ScriptApp.newTrigger('resumeCloning')
    .timeBased()
    .after(60 * 1000)
    .create();
}

function deleteTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'resumeCloning') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function resumeCloning() {
  processChunk();
}
