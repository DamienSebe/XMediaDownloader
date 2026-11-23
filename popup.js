// [X Media DL] popup.js

const LOG_PREFIX = '[X Media DL]';

const enabledEl = document.getElementById('xmdl-enabled');
const folderEl = document.getElementById('xmdl-folder');
const saveBtn = document.getElementById('xmdl-save');
const statusEl = document.getElementById('xmdl-status');

function loadSettings() {
  chrome.storage.local.get({ xmdl_enabled: true, xmdl_folder: 'XMediaDownloader' }, (res) => {
    if (chrome.runtime.lastError) {
      console.error(LOG_PREFIX, 'popup.js: failed to load settings', chrome.runtime.lastError.message);
      return;
    }
    enabledEl.checked = res.xmdl_enabled;
    folderEl.value = res.xmdl_folder;
  });
}

function saveSettings() {
  const settings = {
    xmdl_enabled: enabledEl.checked,
    xmdl_folder: folderEl.value.trim() || 'XMediaDownloader',
  };
  chrome.storage.local.set(settings, () => {
    if (chrome.runtime.lastError) {
      console.error(LOG_PREFIX, 'popup.js: failed to save settings', chrome.runtime.lastError.message);
      statusEl.textContent = 'Error saving settings';
      statusEl.style.color = 'rgb(244, 33, 46)';
      return;
    }
    statusEl.textContent = 'Saved!';
    statusEl.style.color = 'rgb(0, 186, 124)';
    setTimeout(() => (statusEl.textContent = ''), 1500);
  });
}

saveBtn.addEventListener('click', saveSettings);
enabledEl.addEventListener('change', saveSettings);

document.addEventListener('DOMContentLoaded', loadSettings);
loadSettings();
