import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import { setLang } from '@/i18n/lang';
import { ParamPanel } from '@/ui/ParamPanel';

afterEach(() => {
  setLang('en');
});

describe('Telescope liner control', () => {
  it.each([
    ['en', 'Liner pad', 'Fit'],
    ['zh', '內襯墊片', '套合'],
  ] as const)('renders the opt-in switch in the fit section (%s)', (
    lang,
    label,
    groupLabel,
  ) => {
    setLang(lang);
    const values = resolveParams(telescope, {});
    render(
      <ParamPanel
        params={telescope.params}
        values={values}
        overriddenKeys={new Set()}
        onChange={vi.fn()}
        onResetOne={vi.fn()}
        onHighlight={vi.fn()}
      />,
    );

    const fitSection = document.querySelector<HTMLElement>('[data-group-id="fit"]');
    expect(fitSection).not.toBeNull();
    expect(within(fitSection!).getByRole('heading', { name: groupLabel }))
      .toBeInTheDocument();
    expect(within(fitSection!).getByRole('checkbox', { name: label }))
      .not.toBeChecked();
    expect(screen.getAllByRole('checkbox', { name: label })).toHaveLength(1);
  });
});
