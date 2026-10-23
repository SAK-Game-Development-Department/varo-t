/**
 * SkyWay rooms against an in-memory stand-in for the SDK: the creator's
 * browser hosts the RoomCore, others reach it over per-player data streams.
 * Like SkyWay, a stream drops what is written before someone subscribed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeInputs, type InputPacket, type MatchSetup } from '../../src/net/protocol';
import { emptyInput } from '../../src/sim/input-frame';

class Ev<T> {
  private fns: ((v: T) => void)[] = [];
  add(f: (v: T) => void) {
    this.fns.push(f);
  }
  emit(v: T) {
    for (const f of [...this.fns]) queueMicrotask(() => f(v));
  }
}
interface Member {
  id: string;
  name?: string;
}
class Stream {
  contentType = 'data' as const;
  subs: ((d: unknown) => void)[] = [];
  write(d: string | ArrayBuffer) {
    for (const f of this.subs) {
      const copy = typeof d === 'string' ? d : d.slice(0);
      queueMicrotask(() => f(copy));
    }
  }
}
interface Pub {
  id: string;
  publisher: Member;
  metadata?: string;
  contentType: 'data';
  stream: Stream;
}
let ids = 0;
const rooms = new Map<string, FakeRoom>();
class FakeRoom {
  members: Member[] = [];
  publications: Pub[] = [];
  onMemberJoined = new Ev<{ member: Member }>();
  onMemberLeft = new Ev<{ member: Member }>();
  onStreamPublished = new Ev<{ publication: Pub }>();
  onClosed = new Ev<object>();
  constructor(readonly name: string) {}
  async join(init: { name?: string } = {}) {
    if (init.name && this.members.some((m) => m.name === init.name)) throw new Error('name taken');
    const m: Member = { id: `m${++ids}`, name: init.name };
    this.members.push(m);
    this.onMemberJoined.emit({ member: m });
    return {
      ...m,
      publish: async (stream: Stream, o: { metadata?: string }) => {
        const pub: Pub = { id: `p${++ids}`, publisher: m, metadata: o.metadata, contentType: 'data', stream };
        this.publications.push(pub);
        this.onStreamPublished.emit({ publication: pub });
        return pub;
      },
      subscribe: async (id: string) => {
        const pub = this.publications.find((p) => p.id === id)!;
        const onData = new Ev<unknown>();
        pub.stream.subs.push((d) => onData.emit(d));
        return { stream: { onData } };
      },
      leave: async () => this.leave(m),
    };
  }
  leave(m: Member) {
    this.members = this.members.filter((x) => x !== m);
    this.publications = this.publications.filter((p) => p.publisher !== m);
    this.onMemberLeft.emit({ member: m });
  }
  async close() {
    rooms.delete(this.name);
    this.onClosed.emit({});
  }
  async dispose() {}
}

vi.mock('@skyway-sdk/room', () => ({
  nowInSec: () => 0,
  uuidV4: () => 'uuid',
  SkyWayAuthToken: class {
    encode() {
      return 'token';
    }
  },
  SkyWayContext: { Create: async () => ({ dispose() {} }) },
  SkyWayStreamFactory: { createDataStream: async () => new Stream() },
  SkyWayRoom: {
    FindOrCreate: async (_c: unknown, { name }: { name: string }) => {
      if (!rooms.has(name)) rooms.set(name, new FakeRoom(name));
      return rooms.get(name);
    },
    Find: async (_c: unknown, { name }: { name: string }) => {
      const r = rooms.get(name);
      if (!r) throw new Error('not found');
      return r;
    },
  },
}));

type Client = import('../../src/net/relay-client').RelayClient;
let mod: {
  RelayClient: typeof import('../../src/net/relay-client').RelayClient;
  skywayTransport: typeof import('../../src/net/skyway').skywayTransport;
};

beforeAll(async () => {
  vi.stubGlobal('window', { setInterval, clearInterval, addEventListener() {} });
  mod = {
    RelayClient: (await import('../../src/net/relay-client')).RelayClient,
    skywayTransport: (await import('../../src/net/skyway')).skywayTransport,
  };
});

const open: Client[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

function client(code: string, create: boolean, name: string): Client {
  const c = new mod.RelayClient(mod.skywayTransport(code, create), code, name, 'b1');
  open.push(c);
  return c;
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f()).toBe(true);
};

describe('SkyWay rooms', () => {
  it('hosts the room in the creator\'s browser: lobby, start, inputs both ways, leaving', async () => {
    const host = client('2ABC', true, 'HOST');
    await host.joined();
    const guest = client('2ABC', false, 'GUEST');
    await guest.joined();
    await until(() => host.lobby?.players.length === 2 && guest.lobby?.players.length === 2);
    expect([host.slot, guest.slot, host.isHost, guest.isHost]).toEqual([0, 1, true, false]);

    const starts: MatchSetup[] = [];
    host.onStart = (s) => starts.push(s);
    guest.onStart = (s) => starts.push(s);
    host.send({ t: 'start', features: { destructibles: false, seededMap: false, utilityAi: false } });
    await until(() => starts.length === 2);
    expect(starts[0]).toEqual(starts[1]);

    // no direct WebRTC in Node: inputs go through the host's RoomCore, which stamps the sender
    const got: { host: InputPacket[]; guest: InputPacket[] } = { host: [], guest: [] };
    host.setInputSink((p) => got.host.push(p));
    guest.setInputSink((p) => got.guest.push(p));
    guest.sendInputs(encodeInputs(10, [emptyInput(123)], 7));
    host.sendInputs(encodeInputs(10, [emptyInput(456), emptyInput(456)], 7));
    await until(() => got.host.length === 1 && got.guest.length === 1);
    expect([got.host[0].slot, got.host[0].firstTick, got.host[0].frames[0].yaw]).toEqual([1, 10, 123]);
    expect([got.guest[0].slot, got.guest[0].frames.length]).toEqual([0, 2]);

    // the guest leaves mid-match: the host's room runs the leave handshake
    const leaving: number[] = [];
    host.onLeaving = (s) => leaving.push(s);
    guest.close();
    await until(() => leaving.length === 1 && host.lobby?.players.length === 1);
    expect(leaving).toEqual([1]);
  });

  it('closes the room for everyone when its creator leaves', async () => {
    const host = client('3ABC', true, 'HOST');
    await host.joined();
    const guest = client('3ABC', false, 'GUEST');
    await guest.joined();
    let closed = false;
    guest.onClose = () => (closed = true);
    host.close();
    await until(() => closed);
  });

  it('refuses unknown rooms', async () => {
    const c = client('4XYZ', false, 'LOST');
    await expect(c.joined()).rejects.toBe('badRoom');
  });
});
