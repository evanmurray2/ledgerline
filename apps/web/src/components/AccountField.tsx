// Choosing an account in a form: a field-shaped button that opens the same search sheet as the category picker,
// with the accounts under their groups.
import { useState } from 'react';
import { CategoryPickerSheet, primeKeyboard, type PickerGroup } from './CategoryPicker';
import { cx, Icon, inputClass } from './ui';

export function AccountField({
  id,
  value,
  onChange,
  groups,
  track,
}: {
  id?: string;
  value: string;
  onChange: (id: string) => void;
  /** The accounts to pick from, grouped as on the Accounts tab. */
  groups: { name: string; accounts: { id: string; name: string }[] }[];
  track: string;
}) {
  const [open, setOpen] = useState(false);
  const pickerGroups: PickerGroup[] = groups.map((g) => ({
    key: g.name,
    name: g.name,
    categories: g.accounts.map((a) => ({ id: a.id, name: a.name })),
  }));
  const chosen = groups.flatMap((g) => g.accounts).find((a) => a.id === value);
  return (
    <>
      <button
        id={id}
        type="button"
        aria-haspopup="dialog"
        data-track={`${track}.open`}
        onClick={() => {
          primeKeyboard();
          setOpen(true);
        }}
        className={cx(inputClass, 'flex items-center justify-between gap-2 text-left')}
      >
        <span className={cx('truncate', !chosen && 'text-faint')}>{chosen ? chosen.name : 'Choose…'}</span>
        <Icon name="chevR" size={18} className="shrink-0 text-muted" />
      </button>
      {open && (
        <CategoryPickerSheet
          modal
          title="Choose an account"
          noun="account"
          nounPlural="accounts"
          groups={pickerGroups}
          value={value}
          track={track}
          onPick={(v) => {
            onChange(v);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
