/*
 * The settings panel.
 *
 * Dragging a control writes straight into the state and re-applies the CSS variables, so the
 * effect is visible while dragging rather than after confirming. Nothing here computes layout:
 * it only writes numbers the stylesheet already reads.
 */

import { state, DEFAULTS, saveSettings } from './state.js';

/** The controls, in display order. Declared as data so the markup cannot drift from the state. */
const CONTROLS = {
  tablet: [
    { key: 'columns', label: '每行列数', min: 3, max: 12, step: 1, unit: '' },
    { key: 'rows', label: '行数', min: 1, max: 6, step: 1, unit: '' },
    { key: 'cardSize', label: '卡片大小', min: 64, max: 240, step: 2, unit: 'px' },
    { key: 'iconSize', label: '图标大小', min: 32, max: 200, step: 2, unit: 'px' },
    { key: 'cardRadius', label: '圆角', min: 0, max: 60, step: 1, unit: 'px' },
    { key: 'colGap', label: '列间距', min: 0, max: 140, step: 2, unit: 'px' },
    { key: 'rowGap', label: '行间距', min: 0, max: 160, step: 2, unit: 'px' },
    { key: 'captionSize', label: '名字大小', min: 10, max: 34, step: 1, unit: 'px' }
  ],
  tv: [
    { key: 'cardWidth', label: '卡片宽度', min: 320, max: 900, step: 10, unit: 'px' },
    { key: 'groupY', label: '卡片组高度', min: 20, max: 80, step: 1, unit: '%' },
    { key: 'captionY', label: '应用名位置', min: -60, max: 240, step: 2, unit: 'px' },
    { key: 'overlap', label: '遮挡比例', min: 0.25, max: 0.85, step: 0.01, unit: '', percent: true },
    { key: 'captionSize', label: '名字大小', min: 14, max: 48, step: 1, unit: 'px' }
  ]
};

let onChange = () => {};
let onWallpaperChange = async () => null;
let onAppsChange = async () => null;
let onLibraryChange = async () => null;
let onBackupChange = async () => null;
let onStartupChange = async () => null;

/**
 * Builds the panel.
 *
 * The handlers are passed in rather than imported so this module stays about presentation: it does
 * not need to know how a wallpaper is applied or how an app is imported.
 */
export function createPanel(host, handlers) {
  onChange = handlers.onLayoutChange ?? (() => {});
  onWallpaperChange = handlers.onWallpaper ?? (async () => null);
  onAppsChange = handlers.onApps ?? (async () => null);
  onLibraryChange = handlers.onLibrary ?? (async () => null);
  onBackupChange = handlers.onBackup ?? (async () => null);
  onStartupChange = handlers.onStartup ?? (async () => null);

  const panel = document.createElement('aside');
  panel.className = 'settings-panel glass';
  panel.dataset.open = 'no';

  const head = document.createElement('header');
  head.className = 'settings-head';

  const title = document.createElement('h2');
  title.textContent = '设置';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'settings-close';
  close.textContent = '✕';
  close.addEventListener('click', () => togglePanel(false));

  head.append(title, close);
  panel.append(head);

  const body = document.createElement('div');
  body.className = 'settings-body';
  panel.append(body);

  const foot = document.createElement('footer');
  foot.className = 'settings-foot';

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'ghost';
  reset.textContent = '恢复默认';

  reset.addEventListener('click', () => {
    const mode = state.settings.mode;
    state.settings[mode] = { ...DEFAULTS[mode] };
    refresh();
    persist();
  });

  foot.append(reset);
  panel.append(foot);

  function refresh() {
    body.replaceChildren();

    const mode = state.settings.mode;
    const controls = CONTROLS[mode] || [];

    // Appearance and library come first: they are what a user opens this panel for.
    // The wallpaper has one section covering both the library and the choice, so there is no
    // separate wallpaper library entry below.
    body.append(buildWallpaperSection());
    body.append(buildAppsSection());
    body.append(buildLibrarySection(
      '图标库',
      'icons',
      '这里存放可选的图片。在卡片上点右键即可从中选择。'));

    // The clock is not per mode: there is one clock and it should look the same in both.
    body.append(buildClockSection());

    body.append(buildBackupSection());

    const divider = document.createElement('div');
    divider.className = 'settings-divider';
    body.append(divider);

    if (controls.length === 0) {
      const note = document.createElement('p');
      note.className = 'settings-note';
      note.textContent = '这个模式的设置还在做。';
      body.append(note);
      return;
    }

    // The white plate is a switch, not a slider.
    if (mode === 'tablet') {
      body.append(buildToggle('白色卡片底', 'showPlate'));
    }

    for (const control of controls) {
      body.append(buildSlider(control));
    }
  }

  /* ---------------------------------------------------------------- clock */

  function buildClockSection() {
    const section = document.createElement('section');
    section.className = 'settings-section';

    const title = document.createElement('h3');
    title.textContent = '时间与日期';
    section.append(title);

    section.append(buildClockSlider('时间大小', 'size', 16, 150, 1, 'px'));
    section.append(buildClockSlider('水平位置', 'x', 5, 95, 1, '%'));
    section.append(buildClockSlider('垂直位置', 'y', 10, 400, 2, 'px'));

    const toggle = document.createElement('label');
    toggle.className = 'setting setting-toggle';

    const name = document.createElement('span');
    name.textContent = '显示日期';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(state.settings.clock.showDate);

    input.addEventListener('change', () => {
      state.settings.clock.showDate = input.checked;
      persist();
    });

    toggle.append(name, input);
    section.append(toggle);

    // Whether the launcher fills the screen or stops short of the taskbar.
    const fill = document.createElement('label');
    fill.className = 'setting setting-toggle';

    const fillName = document.createElement('span');
    fillName.textContent = '铺满整个屏幕';

    const fillInput = document.createElement('input');
    fillInput.type = 'checkbox';
    fillInput.checked = Boolean(state.settings.fullScreen);

    fillInput.addEventListener('change', () => {
      state.settings.fullScreen = fillInput.checked;
      persist();
    });

    fill.append(fillName, fillInput);
    section.append(fill);

    const fillNote = document.createElement('p');
    fillNote.className = 'settings-hint';
    fillNote.textContent = '任务栏透明时打开（铺满屏幕）；任务栏是不透明的就关掉，否则会盖住任务栏。';
    section.append(fillNote);

    // Starting with Windows. Read from the registry rather than from the settings file, because the
    // registry is what Windows actually acts on — and a stale entry is worth surfacing.
    const auto = document.createElement('label');
    auto.className = 'setting setting-toggle';

    const autoName = document.createElement('span');
    autoName.textContent = '开机自动启动';

    const autoInput = document.createElement('input');
    autoInput.type = 'checkbox';
    autoInput.disabled = true;

    auto.append(autoName, autoInput);
    section.append(auto);

    const autoNote = document.createElement('p');
    autoNote.className = 'settings-hint';
    autoNote.textContent = '正在读取…';
    section.append(autoNote);

    onStartupChange('status').then((status) => {
      if (!status?.ok) {
        autoNote.textContent = '无法读取开机启动设置。';
        return;
      }

      autoInput.disabled = false;
      autoInput.checked = status.enabled;

      autoNote.textContent = status.enabled && !status.matches
        ? `已启用，但指向的位置和当前程序不一致：${status.registered}`
        : '开机后自动进入桌面。可以在任务管理器的「启动」里看到这一项。';

      autoInput.addEventListener('change', async () => {
        autoInput.disabled = true;

        const result = await onStartupChange('set', autoInput.checked);

        autoInput.disabled = false;

        if (result?.ok) {
          autoInput.checked = result.enabled;
          autoNote.textContent = result.enabled
            ? '已设置开机自动启动。'
            : '已取消开机自动启动。';
        } else {
          // Put the switch back rather than leaving it showing a state that was not applied.
          autoInput.checked = !autoInput.checked;
          autoNote.textContent = `设置失败：${result?.error ?? '未知原因'}`;
        }
      });
    });

    return section;
  }

  function buildClockSlider(label, key, min, max, step, unit) {
    const row = document.createElement('label');
    row.className = 'setting';

    const head = document.createElement('span');
    head.className = 'setting-head';

    const name = document.createElement('span');
    name.textContent = label;

    const value = document.createElement('output');
    value.textContent = state.settings.clock[key] + unit;

    head.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = state.settings.clock[key];

    input.addEventListener('input', () => {
      state.settings.clock[key] = Number(input.value);
      value.textContent = input.value + unit;
      onChange();
    });

    input.addEventListener('change', persist);

    row.append(head, input);
    return row;
  }

  /* ---------------------------------------------------------------- wallpaper */

  /**
   * The wallpaper section.
   *
   * One place for everything wallpaper related, with four actions: browse the library, import into
   * it, choose from it, and clear the current choice. The library is the source of truth, so a
   * picture dropped in by hand is pickable without being registered anywhere.
   */
  function buildWallpaperSection() {
    const section = document.createElement('section');
    section.className = 'settings-section';

    const title = document.createElement('h3');
    title.textContent = '壁纸';
    section.append(title);

    const status = document.createElement('p');
    status.className = 'settings-note';

    const describe = () => {
      const current = state.settings.wallpaper;

      if (!current) {
        return '当前：默认背景';
      }

      return current.kind === 'video' ? '当前：视频壁纸' : '当前：图片壁纸';
    };

    status.textContent = describe();

    const row = document.createElement('div');
    row.className = 'settings-row settings-row-wrap';

    // 1. Open the library folder.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ghost';
    open.textContent = '打开壁纸库';
    open.addEventListener('click', () => onLibraryChange('open', 'wallpapers'));

    // 2. Import one or more files into the library.
    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.textContent = '导入图片…';

    importButton.addEventListener('click', async () => {
      importButton.disabled = true;
      importButton.textContent = '等待选择…';

      const result = await onLibraryChange('import', 'wallpapers');

      importButton.disabled = false;
      importButton.textContent = '导入图片…';

      if (result?.ok) {
        const count = result.count ?? 1;

        status.textContent = count > 1
          ? `已导入 ${count} 个文件`
          : `已导入「${result.file?.name ?? result.files?.[0]?.name ?? ''}」`;
      } else if (result?.cancelled) {
        status.textContent = '已取消。';
      } else {
        status.textContent = `导入失败：${result?.error ?? '未知原因'}`;
      }
    });

    // 3. Choose from the library.
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = '选择壁纸…';

    choose.addEventListener('click', async () => {
      const result = await onWallpaperChange('pick');

      status.textContent = result?.ok ? describe() : '已取消。';
    });

    // 4. Back to no wallpaper.
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ghost';
    clear.textContent = '恢复默认';
    clear.disabled = !state.settings.wallpaper;

    clear.addEventListener('click', async () => {
      await onWallpaperChange('clear');
      clear.disabled = true;
      status.textContent = describe();
    });

    row.append(open, importButton, choose, clear);
    section.append(row, status);

    const hint = document.createElement('p');
    hint.className = 'settings-hint';
    hint.textContent = '支持 jpg / png / webp / bmp / gif / svg 与 mp4 / webm / wmv / avi / mov / mkv。' +
      '导入的文件会复制到壁纸库，原文件移动或删除都不影响。';
    section.append(hint);

    return section;
  }

  /* ---------------------------------------------------------------- apps */

  function buildAppsSection() {
    const section = document.createElement('section');
    section.className = 'settings-section';

    const title = document.createElement('h3');
    title.textContent = '应用';
    section.append(title);

    const count = document.createElement('p');
    count.className = 'settings-note';
    count.textContent = `当前显示 ${state.apps.length} 个应用`;
    section.append(count);

    const row = document.createElement('div');
    row.className = 'settings-row';

    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '添加应用…';

    const note = document.createElement('p');
    note.className = 'settings-hint';
    note.textContent = '选择一个程序或快捷方式，它会复制到应用文件夹并立刻出现在桌面上。';

    add.addEventListener('click', async () => {
      add.disabled = true;
      add.textContent = '等待选择…';

      const result = await onAppsChange('import');

      add.disabled = false;
      add.textContent = '添加应用…';

      if (result?.ok) {
        note.textContent = `已添加「${result.name}」`;
        count.textContent = `当前显示 ${state.apps.length} 个应用`;
      } else if (result?.cancelled) {
        note.textContent = '已取消。';
      } else {
        note.textContent = `添加失败：${result?.error ?? '未知原因'}`;
      }
    });

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ghost';
    open.textContent = '打开应用文件夹';

    const folderPath = document.createElement('code');
    folderPath.className = 'settings-path';
    folderPath.textContent = state.folder;

    open.addEventListener('click', () => onAppsChange('openFolder'));

    row.append(add, open);
    section.append(row, footnote(folderPath), note);

    return section;
  }

  /* ---------------------------------------------------------------- picture libraries */

  /**
   * The two picture libraries, each with an import button and a way to open the folder.
   *
   * The folders are the source of truth: pictures dropped in by hand show up in the picker without
   * anything having to be registered, and importing simply copies a file in.
   */
  function buildLibrarySection(title, library, hint) {
    const section = document.createElement('section');
    section.className = 'settings-section';

    const heading = document.createElement('h3');
    heading.textContent = title;
    section.append(heading);

    const row = document.createElement('div');
    row.className = 'settings-row';

    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.textContent = '选择图片导入…';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'ghost';
    openButton.textContent = '打开文件夹';

    const status = document.createElement('p');
    status.className = 'settings-hint';
    status.textContent = hint;

    importButton.addEventListener('click', async () => {
      importButton.disabled = true;
      importButton.textContent = '等待选择…';

      const result = await onLibraryChange('import', library);

      importButton.disabled = false;
      importButton.textContent = '选择图片导入…';

      if (result?.ok) {
        status.textContent = `已导入「${result.file.name}」`;
      } else if (result?.cancelled) {
        status.textContent = '已取消。';
      } else {
        status.textContent = `导入失败：${result?.error ?? '未知原因'}`;
      }
    });

    openButton.addEventListener('click', () => onLibraryChange('open', library));

    row.append(importButton, openButton);
    section.append(row, status);

    return section;
  }

  function footnote(node) {
    const wrapper = document.createElement('p');
    wrapper.className = 'settings-hint';
    wrapper.append(node);
    return wrapper;
  }

  /* ---------------------------------------------------------------- backup */

  /**
   * Backup and restore.
   *
   * Everything the user has customised lives in one folder, so a backup is a zip of it: apps,
   * pictures, card artwork, the wallpaper and the layout settings. Restoring puts all of it back,
   * and takes a safety copy first so restoring the wrong archive is itself undoable.
   */
  function buildBackupSection() {
    const section = document.createElement('section');
    section.className = 'settings-section';

    const heading = document.createElement('h3');
    heading.textContent = '备份与恢复';
    section.append(heading);

    const row = document.createElement('div');
    row.className = 'settings-row';

    const backupButton = document.createElement('button');
    backupButton.type = 'button';
    backupButton.textContent = '立即备份';

    const folderButton = document.createElement('button');
    folderButton.type = 'button';
    folderButton.className = 'ghost';
    folderButton.textContent = '打开备份文件夹';

    const status = document.createElement('p');
    status.className = 'settings-hint';
    status.textContent = '备份包含应用、图标、壁纸、卡片图片与全部设置。';

    backupButton.addEventListener('click', async () => {
      backupButton.disabled = true;
      backupButton.textContent = '正在备份…';

      const result = await onBackupChange('create');

      backupButton.disabled = false;
      backupButton.textContent = '立即备份';

      if (result?.ok) {
        const counts = result.counts ?? {};
        status.textContent =
          `已备份到 ${result.path.split('\\').pop()}：` +
          `${counts.Apps ?? 0} 个应用、${counts.CardArt ?? 0} 个卡片背景、` +
          `${counts.CardIcons ?? 0} 个卡片图标、${counts.Wallpapers ?? 0} 张壁纸`;
      } else {
        status.textContent = `备份失败：${result?.error ?? '未知原因'}`;
      }

      renderBackupList();
    });

    folderButton.addEventListener('click', () => onBackupChange('open'));

    row.append(backupButton, folderButton);

    const list = document.createElement('div');
    list.className = 'backup-list';

    section.append(row, footnote(status), list);

    async function renderBackupList() {
      list.replaceChildren();

      const result = await onBackupChange('list');
      const backups = result?.backups ?? [];

      if (backups.length === 0) {
        return;
      }

      const label = document.createElement('p');
      label.className = 'settings-hint';
      label.textContent = `已有 ${backups.length} 个备份，最近的：`;
      list.append(label);

      // Only the recent few are listed: this is a settings panel, not a file manager, and the
      // folder button is there for anything older.
      for (const backup of backups.slice(0, 4)) {
        const item = document.createElement('div');
        item.className = 'backup-item';

        const info = document.createElement('span');
        info.textContent = `${backup.created} · ${backup.apps ?? '?'} 个应用`;

        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'ghost';
        restore.textContent = '恢复';

        restore.addEventListener('click', async () => {
          restore.disabled = true;
          restore.textContent = '恢复中…';

          const done = await onBackupChange('restore', backup.path);

          restore.disabled = false;
          restore.textContent = '恢复';

          status.textContent = done?.ok
            ? '已恢复。重新打开软件后生效。'
            : `恢复失败：${done?.error ?? '未知原因'}`;
        });

        item.append(info, restore);
        list.append(item);
      }
    }

    renderBackupList();

    return section;
  }

  function persist() {
    saveSettings();
    onChange();
  }

  function buildSlider(control) {
    const row = document.createElement('label');
    row.className = 'setting';

    const head = document.createElement('span');
    head.className = 'setting-head';

    const name = document.createElement('span');
    name.textContent = control.label;

    const value = document.createElement('output');

    // Some values are ratios shown as percentages, and the extra decimals in 0.55 would read as
    // noise, so the display and the stored value are formatted separately.
    const format = (raw) => control.percent
      ? Math.round(raw * 100) + '%'
      : raw + control.unit;

    value.textContent = format(state.settings[state.settings.mode][control.key]);

    head.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = control.min;
    input.max = control.max;
    input.step = control.step;
    input.value = state.settings[state.settings.mode][control.key];

    input.addEventListener('input', () => {
      const raw = Number(input.value);
      state.settings[state.settings.mode][control.key] = raw;
      value.textContent = format(raw);
      // Live: the grid re-reads the variables on the next frame.
      onChange();
    });

    // Writing to disk on every pixel of a drag would hammer the file, so it waits for release.
    input.addEventListener('change', persist);

    row.append(head, input);
    return row;
  }

  function buildToggle(label, key) {
    const row = document.createElement('label');
    row.className = 'setting setting-toggle';

    const name = document.createElement('span');
    name.textContent = label;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(state.settings.tablet[key]);

    input.addEventListener('change', () => {
      state.settings.tablet[key] = input.checked;
      persist();
    });

    row.append(name, input);
    return row;
  }

  host.append(panel);

  return {
    open: () => { refresh(); togglePanel(true); },
    close: () => togglePanel(false),
    refresh
  };
}

export function togglePanel(open) {
  const panel = document.querySelector('.settings-panel');
  if (!panel) return;

  const next = open ?? panel.dataset.open !== 'yes';
  panel.dataset.open = next ? 'yes' : 'no';
}

export function isPanelOpen() {
  return document.querySelector('.settings-panel')?.dataset.open === 'yes';
}
