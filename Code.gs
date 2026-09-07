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
 */
function extractFolderId(url) {
  const match = url.match(/[-\w]{25,}/);
  if (match) return match[0];
  throw new Error('Invalid Google Drive Folder URL. Please provide a complete folder link.');
}

/**
 * Validates that the current user can access the folder
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
 */
function formatSize(bytes) {
  const mb = (bytes / (1024 * 1024)).toFixed(2);
  const gb = (bytes / (1024 * 1024 * 1024)).toFixed(4);
  return { mb, gb };
}

/**
 * Analyze source folder structure & size (optimized traversal)
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
        pageToken: pageToken,
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
        pageToken: pageToken,
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
  if (Number(stats.totalSizeGB) > 10 || totalItems > 2000) {
    stats.warning = true;
    stats.message = `Large folder detected (${totalItems} items, ${stats.totalSizeGB} GB). Cloning will automatically run in time-boxed background chunks.`;
  }

  return { stats, sourceName };
}

/**
 * Initialize cloning state
 */
function startCloning(sourceUrl, destUrl, totalItems) {
  const sourceId = extractFolderId(sourceUrl);
  const destId   = extractFolderId(destUrl);

  validateFolderAccess(sourceId, true);
  validateFolderAccess(destId, false);

  const sourceName = getFolderName(sourceId);
  const destName   = getFolderName(destId);

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
    }
  } catch (e) {
    console.error("Error checking for existing folder name", e);
  }

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

  const state = {
    pendingFolders: [{ sourceId: sourceId, destId: targetFolderId }],
    currentPhase: 'FILES',
    pageToken: null,
    processedCount: 0,
    totalItems,
    status: 'RUNNING',
    startTime: Date.now(),
    sourceName: sourceName,
    destName:   destName + " → " + sourceName
  };

  PropertiesService.getUserProperties().setProperty('CLONE_STATE', JSON.stringify(state));
  deleteTriggers();

  return true;
}

function getCloneProgress() {
  const stateStr = PropertiesService.getUserProperties().getProperty('CLONE_STATE');
  if (!stateStr) return { status: 'ERROR', message: 'No active cloning job.' };
  return JSON.parse(stateStr);
}

/**
 * Copies a page of files concurrently. DriveApp/Drive.Files calls are executed
 * one at a time by Apps Script, so using UrlFetchApp.fetchAll is substantially
 * faster for folders containing many small or medium files.
 *
 * Keep this bounded: increasing this number too much can produce 429 responses
 * from Drive and make the overall clone slower.
 */
const COPY_REQUEST_BATCH_SIZE = 20;

function copyFilesInParallel(files, destinationId, existingNames) {
  const toCopy = files.filter(file => !existingNames[file.name]);
  let copied = 0;
  let failed = 0;

  for (let offset = 0; offset < toCopy.length; offset += COPY_REQUEST_BATCH_SIZE) {
    const batch = toCopy.slice(offset, offset + COPY_REQUEST_BATCH_SIZE);
    const token = ScriptApp.getOAuthToken();
    const requests = batch.map(file => ({
      url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.copyId || file.id)}/copy?supportsAllDrives=true`,
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${token}` },
      payload: JSON.stringify({ name: file.name, parents: [destinationId] }),
      muteHttpExceptions: true
    }));

    const responses = UrlFetchApp.fetchAll(requests);
    responses.forEach((response, index) => {
      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        const copiedFile = JSON.parse(response.getContentText());
        existingNames[batch[index].name] = {
          id: copiedFile.id,
          mimeType: copiedFile.mimeType
        };
        copied++;
      } else {
        failed++;
        console.error(`Copy failed (${code}): ${batch[index].name}; ${response.getContentText().slice(0, 300)}`);
      }
    });
  }

  return { copied, failed };
}

/**
 * A Drive shortcut is not a copy of its target. Recreate it with files.create
 * so that the destination contains a shortcut pointing at the same target.
 */
function createShortcutsInParallel(files, destinationId, existingNames) {
  const shortcuts = files.filter(file =>
    file.mimeType === 'application/vnd.google-apps.shortcut' && !existingNames[file.name]
  );
  let created = 0;
  let failed = 0;

  for (let offset = 0; offset < shortcuts.length; offset += COPY_REQUEST_BATCH_SIZE) {
    const batch = shortcuts.slice(offset, offset + COPY_REQUEST_BATCH_SIZE);
    const token = ScriptApp.getOAuthToken();
    const requests = batch.map(shortcut => {
      const shortcutDetails = { targetId: shortcut.shortcutDetails.targetId };
      if (shortcut.shortcutDetails.targetResourceKey) {
        shortcutDetails.targetResourceKey = shortcut.shortcutDetails.targetResourceKey;
      }

      return {
        url: 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true',
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${token}` },
        payload: JSON.stringify({
          name: shortcut.name,
          mimeType: 'application/vnd.google-apps.shortcut',
          parents: [destinationId],
          shortcutDetails
        }),
        muteHttpExceptions: true
      };
    });

    UrlFetchApp.fetchAll(requests).forEach((response, index) => {
      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        const newShortcut = JSON.parse(response.getContentText());
        existingNames[batch[index].name] = {
          id: newShortcut.id,
          mimeType: 'application/vnd.google-apps.shortcut'
        };
        created++;
      } else {
        failed++;
        console.error(`Shortcut creation failed (${code}): ${batch[index].name}; ${response.getContentText().slice(0, 300)}`);
      }
    });
  }

  return { created, failed };
}

function createFoldersInParallel(folders, destinationId, existingNames) {
  const created = [];
  const toCreate = [];

  folders.forEach(folder => {
    const existing = existingNames[folder.name];
    if (existing && existing.mimeType === 'application/vnd.google-apps.folder') {
      created.push({ sourceId: folder.id, destId: existing.id });
    } else {
      toCreate.push(folder);
    }
  });

  let failed = 0;
  for (let offset = 0; offset < toCreate.length; offset += COPY_REQUEST_BATCH_SIZE) {
    const batch = toCreate.slice(offset, offset + COPY_REQUEST_BATCH_SIZE);
    const token = ScriptApp.getOAuthToken();
    const requests = batch.map(folder => ({
      url: 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true',
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${token}` },
      payload: JSON.stringify({
        name: folder.name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [destinationId]
      }),
      muteHttpExceptions: true
    }));

    UrlFetchApp.fetchAll(requests).forEach((response, index) => {
      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        const destinationFolder = JSON.parse(response.getContentText());
        existingNames[batch[index].name] = {
          id: destinationFolder.id,
          mimeType: 'application/vnd.google-apps.folder'
        };
        created.push({ sourceId: batch[index].id, destId: destinationFolder.id });
      } else {
        failed++;
        console.error(`Folder creation failed (${code}): ${batch[index].name}; ${response.getContentText().slice(0, 300)}`);
      }
    });
  }

  return { created, failed };
}

/**
 * Processes as much work as possible in one execution. The destination index
 * is retained in memory for the whole execution, so a large source folder is
 * not re-scanned before every source page.
 */
function processChunk() {
  const MAX_TIME_MS = 4 * 60 * 1000; // 4 min safety limit
  const start = Date.now();

  const props = PropertiesService.getUserProperties();
  let stateStr = props.getProperty('CLONE_STATE');
  if (!stateStr) return { status: 'ERROR', message: 'State missing' };

  let state = JSON.parse(stateStr);
  if (state.status === 'COMPLETED') return state;

  // This cache intentionally lives only for the current Apps Script execution.
  // Persisting large folder indexes in PropertiesService can exceed its limits.
  const destinationIndexes = {};

  while (state.pendingFolders.length > 0 && Date.now() - start < MAX_TIME_MS) {
    const curr = state.pendingFolders[0];

    // Build the destination index once per folder per execution, rather than
    // once for every source page. This removes a major source of API latency.
    let existing = destinationIndexes[curr.destId];
    if (!existing) {
      existing = {};
      let token = null;
      do {
        const res = Drive.Files.list({
          q: `'${curr.destId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType)',
          pageToken: token,
          pageSize: 1000
        });
        res.files?.forEach(f => existing[f.name] = { id: f.id, mimeType: f.mimeType });
        token = res.nextPageToken;
      } while (token);
      destinationIndexes[curr.destId] = existing;
    }

    // ── Phase: Copy Files ──────────────────────────────────────
    if (state.currentPhase === 'FILES') {
      try {
        const q = `'${curr.sourceId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
        const res = Drive.Files.list({
          q,
          pageToken: state.pageToken,
          pageSize: 1000,
          fields: 'nextPageToken, files(id, name, mimeType, shortcutDetails(targetId, targetMimeType))'
        });

        // Flatten shortcuts: copy the target item instead of creating another
        // shortcut. Folder targets are handled in the folder phase below.
        const files = (res.files || [])
          .filter(file => file.mimeType !== 'application/vnd.google-apps.shortcut' ||
            file.shortcutDetails?.targetMimeType !== 'application/vnd.google-apps.folder')
          .map(file => file.mimeType === 'application/vnd.google-apps.shortcut'
            ? { ...file, copyId: file.shortcutDetails.targetId }
            : file);
        const result = copyFilesInParallel(files, curr.destId, existing);
        state.failedCount = (state.failedCount || 0) + result.failed;
        state.processedCount += files.length;

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
        const q = `'${curr.sourceId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`;
        const res = Drive.Files.list({
          q,
          pageToken: state.pageToken,
          pageSize: 1000,
          fields: 'nextPageToken, files(id, name, mimeType, shortcutDetails(targetId, targetMimeType))'
        });

        const folders = (res.files || [])
          .filter(item => item.mimeType === 'application/vnd.google-apps.folder' ||
            item.shortcutDetails?.targetMimeType === 'application/vnd.google-apps.folder')
          .map(item => item.mimeType === 'application/vnd.google-apps.shortcut'
            ? { ...item, id: item.shortcutDetails.targetId }
            : item);
        const folderResult = createFoldersInParallel(folders, curr.destId, existing);
        state.failedCount = (state.failedCount || 0) + folderResult.failed;
        state.processedCount += folders.length;
        folderResult.created.forEach(folder => {
          state.pendingFolders.push({ sourceId: folder.sourceId, destId: folder.destId });
        });
        /* Old serial folder creation loop retained below temporarily for patch context.
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
        */

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

function setupTrigger() {
  deleteTriggers();
  ScriptApp.newTrigger('resumeCloning')
    .timeBased()
    .after(30 * 1000)
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
