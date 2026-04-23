import { describe, it, expect, vi } from 'vitest';
import { DeployPauseHandler } from '../src/response/deploy-pause.js';
import { TokenRevokeHandler } from '../src/response/token-revoke.js';
import { SignerRotateHandler } from '../src/response/signer-rotate.js';
import { QuarantineBuilderHandler } from '../src/response/quarantine-builder.js';
import { createAlert } from '../src/alerts/bus.js';

describe('DeployPauseHandler', () => {
  it('ignores non-critical alerts', async () => {
    const handler = new DeployPauseHandler(9090);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await handler.handle(createAlert('supply-chain', 'test', 'high', 'msg'));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('ignores non-supply-chain alerts', async () => {
    const handler = new DeployPauseHandler(9090);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await handler.handle(createAlert('yieldclaw', 'halt', 'critical', 'msg'));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('sends pause on critical supply-chain alert', async () => {
    const handler = new DeployPauseHandler(9090);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    await handler.handle(createAlert('supply-chain', 'worm_propagation', 'critical', 'worm detected'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('9090');
    expect(url).toContain('/api/v1/pause');
    fetchSpy.mockRestore();
  });

  it('sends to both ports when deploy runner port configured', async () => {
    const handler = new DeployPauseHandler(9090, 9091);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    await handler.handle(createAlert('supply-chain', 'worm_propagation', 'critical', 'worm'));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it('handles fetch failures gracefully', async () => {
    const handler = new DeployPauseHandler(9090);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(handler.handle(
      createAlert('supply-chain', 'worm_propagation', 'critical', 'worm'),
    )).resolves.not.toThrow();

    fetchSpy.mockRestore();
  });
});

describe('TokenRevokeHandler', () => {
  it('ignores non-critical alerts', async () => {
    const onRevoke = vi.fn();
    const handler = new TokenRevokeHandler({ githubToken: 'tok', onRevoke });
    await handler.handle(createAlert('supply-chain', 'credential_radius', 'high', 'msg'));
    expect(onRevoke).not.toHaveBeenCalled();
  });

  it('ignores non-credential-related alerts', async () => {
    const onRevoke = vi.fn();
    const handler = new TokenRevokeHandler({ githubToken: 'tok', onRevoke });
    await handler.handle(createAlert('supply-chain', 'quarantine_window', 'critical', 'msg'));
    expect(onRevoke).not.toHaveBeenCalled();
  });

  it('triggers GitHub token revocation on credential_radius alert', async () => {
    const onRevoke = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const handler = new TokenRevokeHandler({ githubToken: 'ghp_test', onRevoke });

    await handler.handle(createAlert('supply-chain', 'credential_radius', 'critical', 'creds compromised'));

    expect(fetchSpy).toHaveBeenCalled();
    expect(onRevoke).toHaveBeenCalledWith('github', expect.any(Object));
    fetchSpy.mockRestore();
  });

  it('triggers npm token revocation on worm_propagation alert', async () => {
    const onRevoke = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const handler = new TokenRevokeHandler({ npmToken: 'npm_test', onRevoke });

    await handler.handle(createAlert('supply-chain', 'worm_propagation', 'critical', 'worm'));

    expect(fetchSpy).toHaveBeenCalled();
    expect(onRevoke).toHaveBeenCalledWith('npm', expect.any(Object));
    fetchSpy.mockRestore();
  });
});

describe('SignerRotateHandler', () => {
  it('ignores non-critical alerts', async () => {
    const onRotate = vi.fn();
    const handler = new SignerRotateHandler({ onRotate });
    await handler.handle(createAlert('supply-chain', 'worm_propagation', 'high', 'msg'));
    expect(onRotate).not.toHaveBeenCalled();
  });

  it('ignores non-rotation-triggering alerts', async () => {
    const onRotate = vi.fn();
    const handler = new SignerRotateHandler({ onRotate });
    await handler.handle(createAlert('supply-chain', 'quarantine_window', 'critical', 'msg'));
    expect(onRotate).not.toHaveBeenCalled();
  });

  it('triggers rotation on credential_radius alert', async () => {
    const onRotate = vi.fn();
    const handler = new SignerRotateHandler({ onRotate });
    await handler.handle(createAlert('supply-chain', 'credential_radius', 'critical', 'msg'));
    expect(onRotate).toHaveBeenCalled();
  });

  it('calls rotation endpoint when configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    const handler = new SignerRotateHandler({ rotationEndpoint: 'http://localhost:8080/rotate' });

    await handler.handle(createAlert('supply-chain', 'worm_propagation', 'critical', 'worm'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:8080/rotate');
    fetchSpy.mockRestore();
  });

  it('triggers on lockfile_tampered', async () => {
    const onRotate = vi.fn();
    const handler = new SignerRotateHandler({ onRotate });
    await handler.handle(createAlert('supply-chain', 'lockfile_tampered', 'critical', 'tampered'));
    expect(onRotate).toHaveBeenCalled();
  });
});

describe('QuarantineBuilderHandler', () => {
  it('ignores non-critical alerts', async () => {
    const handler = new QuarantineBuilderHandler({ pausePort: 9090 });
    await handler.handle(createAlert('supply-chain', 'worm', 'high', 'msg', { builderId: 'b1' }));
    expect(handler.isQuarantined('b1')).toBe(false);
  });

  it('ignores alerts without builderId', async () => {
    const handler = new QuarantineBuilderHandler({ pausePort: 9090 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await handler.handle(createAlert('supply-chain', 'worm', 'critical', 'msg'));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('quarantines builder on critical supply-chain alert', async () => {
    const onQuarantine = vi.fn();
    const handler = new QuarantineBuilderHandler({ pausePort: 9090, onQuarantine });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    await handler.handle(createAlert('supply-chain', 'worm', 'critical', 'msg', { builderId: 'builder-1' }));

    expect(handler.isQuarantined('builder-1')).toBe(true);
    expect(onQuarantine).toHaveBeenCalledWith('builder-1', expect.any(Object));
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('does not double-quarantine same builder', async () => {
    const handler = new QuarantineBuilderHandler({ pausePort: 9090 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    await handler.handle(createAlert('supply-chain', 'worm', 'critical', 'msg', { builderId: 'b1' }));
    await handler.handle(createAlert('supply-chain', 'worm', 'critical', 'msg', { builderId: 'b1' }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('tracks multiple quarantined builders', async () => {
    const handler = new QuarantineBuilderHandler({ pausePort: 9090 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    await handler.handle(createAlert('supply-chain', 'worm', 'critical', 'msg', { builderId: 'b1' }));
    await handler.handle(createAlert('supply-chain', 'worm', 'critical', 'msg', { builderId: 'b2' }));

    expect(handler.getQuarantinedBuilders()).toEqual(['b1', 'b2']);
    fetchSpy.mockRestore();
  });

  it('releases quarantined builders', async () => {
    const handler = new QuarantineBuilderHandler({ pausePort: 9090 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    await handler.handle(createAlert('supply-chain', 'worm', 'critical', 'msg', { builderId: 'b1' }));
    expect(handler.isQuarantined('b1')).toBe(true);

    handler.releaseBuilder('b1');
    expect(handler.isQuarantined('b1')).toBe(false);
    fetchSpy.mockRestore();
  });
});
