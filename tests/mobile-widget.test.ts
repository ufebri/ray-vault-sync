import { formatRelativeTime, MobileSyncWidget } from '../src/mobile-widget';
import { DEFAULT_SETTINGS } from '../src/settings';

describe('MobileSyncWidget & Settings', () => {
    test('DEFAULT_SETTINGS includes mobile widget and sync tracking defaults', () => {
        expect(DEFAULT_SETTINGS.enableMobileSidebarWidget).toBe(true);
        expect(DEFAULT_SETTINGS.lastSyncTimestamp).toBeNull();
        expect(DEFAULT_SETTINGS.lastSyncStatus).toBe('idle');
    });

    class FakeElement {
        children: FakeElement[] = [];
        attributes: Record<string, string> = {};
        listeners: Record<string, () => void> = {};
        text = '';
        className = '';
        disabled = false;
        parentElement: FakeElement | null = null;

        constructor(public id = '') {}

        createEl() {
            const child = new FakeElement();
            child.parentElement = this;
            this.children.push(child);
            return child;
        }

        createSpan() { return this.createEl(); }
        createDiv() { return this.createEl(); }
        addEventListener(event: string, handler: () => void) { this.listeners[event] = handler; }
        addClass() {}
        removeClass() {}
        setText(text: string) { this.text = text; }
        setAttribute(name: string, value: string) { this.attributes[name] = value; }
        removeAttribute(name: string) { delete this.attributes[name]; }
        remove() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); }
        querySelector(selector: string) {
            return selector === '#ray-vault-sync-mobile-card'
                ? this.children.find(child => child.id === 'ray-vault-sync-mobile-card') ?? null
                : null;
        }
        prepend(child: FakeElement) {
            child.parentElement = this;
            this.children.unshift(child);
        }
    }

    describe('MobileSyncWidget', () => {
        let view: FakeElement;
        let plugin: {
            settings: {
                enableMobileSidebarWidget: boolean;
                lastSyncStatus: string;
                lastSyncTimestamp: number | null;
                lastSyncMessage?: string;
            };
            app: { workspace: { getLeavesOfType: jest.Mock } };
            runSync: jest.Mock;
        };
        const setIntervalMock = jest.fn(() => 12);
        const clearIntervalMock = jest.fn();

        beforeEach(() => {
            view = new FakeElement();
            plugin = {
                settings: {
                    enableMobileSidebarWidget: true,
                    lastSyncStatus: 'idle',
                    lastSyncTimestamp: null
                },
                app: {
                    workspace: {
                        getLeavesOfType: jest.fn().mockReturnValue([{ view: { containerEl: view } }])
                    }
                },
                runSync: jest.fn()
            };
            setIntervalMock.mockClear();
            clearIntervalMock.mockClear();
            Object.defineProperty(globalThis, 'window', {
                configurable: true,
                value: { setInterval: setIntervalMock, clearInterval: clearIntervalMock }
            });
            Object.defineProperty(globalThis, 'createDiv', {
                configurable: true,
                value: ({ attr }: { attr?: { id?: string } }) => new FakeElement(attr?.id)
            });
        });

        test('mounts once, handles sync states, and removes its timer on destroy', () => {
            const widget = new MobileSyncWidget(plugin as never);
            widget.mount();

            expect(view.children).toHaveLength(1);
            expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 30_000);

            widget.mount();
            expect(view.children).toHaveLength(1);

            const card = view.children[0];
            const button = card.children[0];
            button.listeners.click();
            expect(plugin.runSync).toHaveBeenCalledWith(false);

            widget.setSyncing();
            expect(button.disabled).toBe(true);
            widget.setSuccess(Date.now());
            expect(button.disabled).toBe(false);
            widget.setError('GitHub rate limit reached');

            plugin.settings.lastSyncStatus = 'error';
            plugin.settings.lastSyncMessage = 'Network unavailable';
            widget.updateState();

            widget.destroy();
            expect(view.children).toHaveLength(0);
            expect(clearIntervalMock).toHaveBeenCalledWith(12);
            widget.destroy();
            expect(clearIntervalMock).toHaveBeenCalledTimes(1);
        });

        test('does not mount when disabled or when the file explorer is unavailable', () => {
            const widget = new MobileSyncWidget(plugin as never);
            plugin.settings.enableMobileSidebarWidget = false;
            widget.mount();
            expect(plugin.app.workspace.getLeavesOfType).not.toHaveBeenCalled();

            plugin.settings.enableMobileSidebarWidget = true;
            plugin.app.workspace.getLeavesOfType.mockReturnValue([]);
            widget.mount();
            expect(view.children).toHaveLength(0);
        });
    });

    describe('formatRelativeTime', () => {
        const baseNow = 1725534000000; // Fixed timestamp

        test('returns "Never synced" when timestamp is null or 0', () => {
            expect(formatRelativeTime(null, baseNow)).toBe('Never synced');
            expect(formatRelativeTime(0, baseNow)).toBe('Never synced');
        });

        test('returns "Just now" when synced within 30 seconds', () => {
            expect(formatRelativeTime(baseNow - 10000, baseNow)).toBe('Just now');
            expect(formatRelativeTime(baseNow - 29000, baseNow)).toBe('Just now');
        });

        test('returns minutes format for less than 1 hour', () => {
            expect(formatRelativeTime(baseNow - 60000, baseNow)).toBe('1m ago');
            expect(formatRelativeTime(baseNow - 5 * 60000, baseNow)).toBe('5m ago');
            expect(formatRelativeTime(baseNow - 59 * 60000, baseNow)).toBe('59m ago');
        });

        test('returns hours format for 1-23 hours', () => {
            expect(formatRelativeTime(baseNow - 60 * 60000, baseNow)).toBe('1h ago');
            expect(formatRelativeTime(baseNow - 3 * 3600000, baseNow)).toBe('3h ago');
            expect(formatRelativeTime(baseNow - 23 * 3600000, baseNow)).toBe('23h ago');
        });

        test('returns days format for 24 hours or more', () => {
            expect(formatRelativeTime(baseNow - 24 * 3600000, baseNow)).toBe('1d ago');
            expect(formatRelativeTime(baseNow - 5 * 86400000, baseNow)).toBe('5d ago');
        });
    });
});
