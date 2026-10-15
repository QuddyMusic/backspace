import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BotSummary } from '@backspace/shared';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
  regenerateToken: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../api/client', () => ({
  api: {
    bots: {
      list: mocks.list,
      listTokens: mocks.listTokens,
      createToken: mocks.createToken,
      revokeToken: mocks.revokeToken,
      regenerateToken: mocks.regenerateToken,
    },
    uploads: { url: (p: string) => p },
  },
}));
vi.mock('../../../i18n/errors', () => ({ describeError: (e: unknown) => (e instanceof Error ? e.message : 'error') }));
vi.mock('../../../i18n/formatters', () => ({
  useFormatters: () => ({ formatMediumDate: () => 'DATE', formatRelativeTime: () => 'AGO' }),
}));
vi.mock('../../ui/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../ui/ImageCropModal', () => ({ ImageCropModal: () => null }));
vi.mock('../../../stores/transferStore', () => ({ useTransferStore: () => undefined }));
vi.mock('../../../utils/waitForTransfer', () => ({ waitForTransferAttachment: vi.fn() }));

import { BotsPanel } from './BotsPanel';

const bot: BotSummary = {
  id: 'b1',
  username: 'echo_bot',
  displayName: 'Echo_bot',
  avatar: null,
  avatarColor: '#123456',
  createdAt: 1_700_000_000_000,
};

const openTokens = async () => {
  render(<BotsPanel />);
  fireEvent.click(await screen.findByText('settings:bots.actions.tokens'));
};

describe('BotsPanel tokens', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.list.mockResolvedValue({ bots: [bot] });
  });
  afterEach(() => cleanup());

  it('lists tokens with their label and last use, never a secret', async () => {
    mocks.listTokens.mockResolvedValue({
      tokens: [
        { id: 't1', name: 'ci', createdAt: 1, lastUsedAt: 2 },
        { id: 't2', name: null, createdAt: 3, lastUsedAt: null },
      ],
      legacy: false,
    });
    await openTokens();
    expect(await screen.findByText('ci')).toBeTruthy();
    expect(screen.getByText('settings:bots.tokens.unnamed')).toBeTruthy();
    expect(screen.getByText(/settings:bots.tokens.lastUsed/)).toBeTruthy();
    expect(screen.getByText(/settings:bots.tokens.neverUsed/)).toBeTruthy();
    expect(mocks.listTokens).toHaveBeenCalledWith('b1');
  });

  it('tells the owner a bot still runs on the old token', async () => {
    mocks.listTokens.mockResolvedValue({ tokens: [], legacy: true });
    await openTokens();
    expect(await screen.findByText('settings:bots.tokens.legacy')).toBeTruthy();
    expect(screen.queryByText('settings:bots.tokens.empty')).toBeNull();
  });

  it('creates a labelled token, shows its secret once and drops the legacy hint', async () => {
    mocks.listTokens.mockResolvedValue({ tokens: [], legacy: true });
    mocks.createToken.mockResolvedValue({ id: 't9', name: 'prod', createdAt: 5, lastUsedAt: null, token: 'bsb_secret' });
    await openTokens();
    fireEvent.change(await screen.findByLabelText('settings:bots.tokens.nameLabel'), { target: { value: ' prod ' } });
    fireEvent.click(screen.getByText('settings:bots.tokens.create'));

    expect(await screen.findByText('bsb_secret')).toBeTruthy();
    expect(mocks.createToken).toHaveBeenCalledWith('b1', { name: 'prod' });
    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.queryByText('settings:bots.tokens.legacy')).toBeNull();
  });

  it('revokes one token after a confirmation', async () => {
    mocks.listTokens.mockResolvedValue({ tokens: [{ id: 't1', name: 'ci', createdAt: 1, lastUsedAt: null }], legacy: false });
    mocks.revokeToken.mockResolvedValue({ success: true });
    await openTokens();
    fireEvent.click(await screen.findByText('settings:bots.tokens.revoke'));
    expect(mocks.revokeToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('settings:bots.tokens.confirmRevoke'));

    await waitFor(() => expect(mocks.revokeToken).toHaveBeenCalledWith('b1', 't1'));
    await waitFor(() => expect(screen.queryByText('ci')).toBeNull());
  });

  it('stops offering new tokens at the limit', async () => {
    mocks.listTokens.mockResolvedValue({
      tokens: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: `n${i}`, createdAt: 1, lastUsedAt: null })),
      legacy: false,
    });
    await openTokens();
    const create = await screen.findByText('settings:bots.tokens.create');
    expect(create).toBeDisabled();
  });
});
