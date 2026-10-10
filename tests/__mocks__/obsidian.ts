export function setIcon(el: HTMLElement, iconId: string): void {
    // mock setIcon
}

export const requestUrl = jest.fn();

export class TFile {}

export class Notice {
    static messages: string[] = [];
    constructor(public message: string) {
        Notice.messages.push(message);
    }
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
    registerDomEvent() {}
}

export class PluginSettingTab {
    containerEl = { empty: jest.fn() };
    constructor(public app: any, public plugin: any) {}
}

export class Setting {
    static instances: Setting[] = [];
    name = '';
    description = '';
    controls: Array<Record<string, any>> = [];
    constructor(public containerEl: any) {
        Setting.instances.push(this);
    }
    setName(name: string) { this.name = name; return this; }
    setDesc(description: string) { this.description = description; return this; }
    addText(callback: (control: any) => unknown) {
        const control = {
            value: '',
            placeholder: '',
            onChangeHandler: undefined as ((value: string) => unknown) | undefined,
            onChange: (handler: (value: string) => unknown) => {
                control.onChangeHandler = handler;
                return control;
            },
            setPlaceholder: (value: string) => { control.placeholder = value; return control; },
            setValue: (value: string) => { control.value = value; return control; }
        };
        callback(control);
        this.controls.push(control);
        return this;
    }
    addToggle(callback: (control: any) => unknown) {
        const control = {
            value: false,
            onChangeHandler: undefined as ((value: boolean) => unknown) | undefined,
            onChange: (handler: (value: boolean) => unknown) => {
                control.onChangeHandler = handler;
                return control;
            },
            setValue: (value: boolean) => { control.value = value; return control; }
        };
        callback(control);
        this.controls.push(control);
        return this;
    }
    addTextArea(callback: (control: any) => unknown) {
        return this.addText(callback);
    }
    addButton(cb: (btn: { setButtonText: (t: string) => unknown; onClick: (fn: () => void) => unknown }) => void) {
        const button = {
            text: '',
            onClickHandler: undefined as (() => void) | undefined,
            setButtonText: (text: string) => {
                button.text = text;
                return button;
            },
            onClick: (handler: () => void) => {
                button.onClickHandler = handler;
                return button;
            }
        };
        cb(button);
        this.controls.push(button);
        return this;
    }
}

export const Platform = {
    isMobile: false,
    isDesktop: true
};
