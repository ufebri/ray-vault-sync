import { formatRelativeTime } from '../src/mobile-widget';
import { DEFAULT_SETTINGS } from '../src/settings';

describe('MobileSyncWidget & Settings', () => {
    test('DEFAULT_SETTINGS includes mobile widget and sync tracking defaults', () => {
        expect(DEFAULT_SETTINGS.enableMobileSidebarWidget).toBe(true);
        expect(DEFAULT_SETTINGS.lastSyncTimestamp).toBeNull();
        expect(DEFAULT_SETTINGS.lastSyncStatus).toBe('idle');
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
