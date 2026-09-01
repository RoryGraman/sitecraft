import type { TabInfo } from '@sitecraft/shared';
import { hostOf, truncate } from '../util';

export interface TabPickerProps {
  tabs: TabInfo[];
  selectedTabId: number | null;
  onSelect(tabId: number): void;
  onRefresh(): void;
  loading?: boolean;
}

function tabLabel(tab: TabInfo): string {
  const host = hostOf(tab.url);
  const title = tab.title.trim() || tab.url;
  return truncate(host ? `${host}: ${title}` : title, 64);
}

export function TabPicker({ tabs, selectedTabId, onSelect, onRefresh, loading = false }: TabPickerProps) {
  return (
    <div className="tab-picker">
      <label className="tab-picker-label" htmlFor="sitecraft-tab-picker">
        Target tab
      </label>
      <select
        id="sitecraft-tab-picker"
        data-testid="tab-picker"
        className="tab-picker-select"
        value={selectedTabId ?? ''}
        disabled={tabs.length === 0}
        onChange={(e) => {
          const id = Number(e.target.value);
          if (Number.isFinite(id)) onSelect(id);
        }}
      >
        {tabs.length === 0 ? (
          <option value="">No open tabs</option>
        ) : (
          tabs.map((tab) => (
            <option key={tab.tabId} value={tab.tabId}>
              {tabLabel(tab)}
            </option>
          ))
        )}
      </select>
      <button
        type="button"
        className="btn btn-small"
        data-testid="tab-refresh"
        onClick={onRefresh}
        disabled={loading}
        title="Reload the tab list"
      >
        {loading ? 'Loading' : 'Refresh'}
      </button>
    </div>
  );
}
