import { describe, expect, it } from 'vitest';
import {
  ConnectorRegistry,
  ToolRegistry,
  type AnyTool,
  type Connector,
} from '@legion-collective/core';
import { registerConnectorTools, unregisterConnectorTools } from './LegionProcess.js';

function fakeTool(name: string): AnyTool {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ status: 'success' }),
  };
}

function fakeConnector(name: string, tools?: AnyTool[]): Connector {
  return {
    name,
    start: async () => undefined,
    deliver: async () => ({ status: 'delivered' }),
    stop: async () => undefined,
    ...(tools === undefined ? {} : { tools: () => tools }),
  };
}

describe('registerConnectorTools', () => {
  it('returns an empty list when the connector has no tools()', () => {
    const registry = new ToolRegistry();
    expect(registerConnectorTools(fakeConnector('teams'), registry)).toEqual([]);
    expect(registry.listAll()).toEqual([]);
  });

  it('registers tools that carry the connector prefix', () => {
    const registry = new ToolRegistry();
    const connector = fakeConnector('teams', [
      fakeTool('teams__send_card'),
      fakeTool('teams__post_reaction'),
    ]);
    expect(registerConnectorTools(connector, registry)).toEqual([
      'teams__send_card',
      'teams__post_reaction',
    ]);
    expect(registry.listAll()).toEqual(['teams__send_card', 'teams__post_reaction']);
  });

  it('rejects a tool whose name lacks the connector prefix and registers nothing', () => {
    const registry = new ToolRegistry();
    const connector = fakeConnector('teams', [fakeTool('teams__ok'), fakeTool('send_card')]);
    expect(() => registerConnectorTools(connector, registry)).toThrow(/teams__/);
    expect(registry.listAll()).toEqual([]);
  });

  it('rejects duplicate tool names within one connector', () => {
    const registry = new ToolRegistry();
    const connector = fakeConnector('teams', [fakeTool('teams__x'), fakeTool('teams__x')]);
    expect(() => registerConnectorTools(connector, registry)).toThrow(/duplicate/i);
    expect(registry.listAll()).toEqual([]);
  });

  it('rolls back already-registered tools when a later registration collides', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('teams__taken'));
    const connector = fakeConnector('teams', [fakeTool('teams__first'), fakeTool('teams__taken')]);
    expect(() => registerConnectorTools(connector, registry)).toThrow(/already registered/i);
    expect(registry.listAll()).toEqual(['teams__taken']);
  });
});

describe('unregisterConnectorTools', () => {
  it('removes every name and tolerates missing names', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('teams__a'));
    registry.register(fakeTool('teams__b'));
    unregisterConnectorTools(registry, ['teams__a', 'teams__b', 'teams__missing']);
    expect(registry.listAll()).toEqual([]);
  });
});

describe('ConnectorRegistry parity', () => {
  it('accepts a connector that implements tools()', () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('teams', [fakeTool('teams__x')]));
    expect(registry.get('teams')?.tools?.()).toHaveLength(1);
  });
});
