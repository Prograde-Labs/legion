import { ConnectorRegistry } from './ConnectorRegistry.js';
import type { Connector } from './Connector.js';

function makeConnector(name: string, canDeliver?: (participantId: string) => boolean): Connector {
  return {
    name,
    ...(canDeliver ? { canDeliver } : {}),
    async start() {},
    async deliver() {
      return { status: 'delivered' };
    },
    async stop() {},
  };
}

describe('ConnectorRegistry', () => {
  it('registers a connector by name', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    expect(reg.get('web')).toBeDefined();
  });

  it('throws if the same name is registered twice', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    expect(() => reg.register(makeConnector('web'))).toThrow(/already registered/i);
  });

  it('deregisters a connector and its active-participant set', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.setActive('user-1', 'web');
    reg.deregister('web');
    expect(reg.get('web')).toBeUndefined();
    expect(reg.getActiveConnectors('user-1')).toHaveLength(0);
  });

  it('get() returns undefined for an unknown name', () => {
    expect(new ConnectorRegistry().get('nope')).toBeUndefined();
  });

  it('getAll() returns every registered connector', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.register(makeConnector('teams'));
    expect(reg.getAll()).toHaveLength(2);
  });

  it('setActive marks a participant as connected on a connector', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.setActive('user-1', 'web');
    expect(reg.getActiveConnectors('user-1')).toHaveLength(1);
    expect(reg.getActiveConnectors('user-1')[0].name).toBe('web');
  });

  it('setActive is a no-op for unregistered connectors', () => {
    const reg = new ConnectorRegistry();
    expect(() => reg.setActive('user-1', 'ghost')).not.toThrow();
  });

  it('clearActive removes a participant from the active set', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.setActive('user-1', 'web');
    reg.clearActive('user-1', 'web');
    expect(reg.getActiveConnectors('user-1')).toHaveLength(0);
  });

  it('clearActive is a no-op if participant was not active', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    expect(() => reg.clearActive('user-1', 'web')).not.toThrow();
  });

  it('getActiveConnectors returns connectors from multiple registrations', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.register(makeConnector('teams'));
    reg.setActive('user-1', 'web');
    reg.setActive('user-1', 'teams');
    expect(reg.getActiveConnectors('user-1')).toHaveLength(2);
  });

  it('getActiveConnectors returns empty array when participant has no active connectors', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    expect(reg.getActiveConnectors('user-1')).toHaveLength(0);
  });

  it('active sets are independent per connector', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('web'));
    reg.register(makeConnector('teams'));
    reg.setActive('user-1', 'web');
    expect(reg.getActiveConnectors('user-1')).toHaveLength(1);
    expect(reg.getActiveConnectors('user-1')[0].name).toBe('web');
  });

  it('getDeliverableConnectors includes connectors whose predicate accepts the participant', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('teams', (id) => id === 'user-1'));
    reg.register(makeConnector('web', (id) => id === 'user-2'));
    expect(reg.getDeliverableConnectors('user-1').map((c) => c.name)).toEqual(['teams']);
  });

  it('getDeliverableConnectors includes connectors without a predicate', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('legacy'));
    expect(reg.getDeliverableConnectors('user-1').map((c) => c.name)).toEqual(['legacy']);
  });

  it('getDeliverableConnectors does not depend on active state', () => {
    const reg = new ConnectorRegistry();
    reg.register(makeConnector('teams', () => true));
    expect(reg.getActiveConnectors('user-1')).toHaveLength(0);
    expect(reg.getDeliverableConnectors('user-1')).toHaveLength(1);
  });
  it('isolates throwing deliverability predicates', () => {
    const reg = new ConnectorRegistry();
    reg.register(
      makeConnector('broken', () => {
        throw new Error('bad predicate');
      }),
    );
    reg.register(makeConnector('good', () => true));
    expect(reg.getDeliverableConnectors('user-1').map((c) => c.name)).toEqual(['good']);
  });
});
