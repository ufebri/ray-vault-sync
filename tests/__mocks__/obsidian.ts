export function setIcon(el: HTMLElement, iconId: string): void {
    // mock setIcon
}

export class Notice {
    constructor(public message: string) {}
}

export class Plugin {
    app: any;
    manifest: any;
    loadData() { return Promise.resolve({}); }
    saveData() { return Promise.resolve(); }
    addStatusBarItem() { return { setText: () => {} }; }
    addRibbonIcon() { return { addClass: () => {} }; }
    addCommand() {}
    addSettingTab() {}
    registerEvent() {}
    registerInterval() {}
}

export class PluginSettingTab {
    constructor(public app: any, public plugin: any) {}
}

export class Setting {
    constructor(public containerEl: any) {}
    setName() { return this; }
    setDesc() { return this; }
    addText() { return this; }
    addToggle() { return this; }
    addTextArea() { return this; }
}

export const Platform = {
    isMobile: false,
    isDesktop: true
};
