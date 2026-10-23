/**
 * SkyWay (NTT, free plan) as a stand-in for the Cloudflare relay, used when
 * the relay is out of free quota or unreachable.
 *
 * There is no server of ours here: the browser that creates the room runs
 * the RoomCore itself (lobby, signaling, leave handshake, input fallback) and
 * every other player talks to it over SkyWay data streams. SkyWay's own TURN
 * (free plan: 500 GB/month) carries the pairs that cannot connect directly.
 * When the creator leaves, the room ends.
 *
 * Plumbing: the host publishes one data stream per player (metadata = that
 * player's member id); each player publishes one stream for the host
 * (metadata "host"). A stream only reaches members that already subscribed,
 * so a player repeats SYN until the host answers ACK, and only then counts as
 * connected.
 *
 * The SDK (~2 MB) is loaded only when a SkyWay room is used.
 */
import type { LocalDataStream, LocalP2PRoomMember, P2PRoom, RemoteDataStream, RoomPublication } from '@skyway-sdk/room';
import { NET } from '../config/net';
import type { Transport } from './relay-client';
import { type Conn, RoomCore } from './room';

const APP_ID: string = import.meta.env.VITE_SKYWAY_APP_ID ?? '';
const SECRET: string = import.meta.env.VITE_SKYWAY_SECRET ?? '';

/** SkyWay credentials were built in (.env.local). */
export const skywayAvailable = (): boolean => !!APP_ID && !!SECRET;

const HOST_NAME = 'host';
const SYN = '\u0000syn';
const ACK = '\u0000ack';
const BYE = '\u0000bye';
const SYN_EVERY_MS = 300;
/** give up on joining when the host never answers */
const JOIN_TIMEOUT_MS = 15_000;

type Sdk = typeof import('@skyway-sdk/room');
type Data = string | ArrayBuffer | object;

function toPayload(d: Data): string | ArrayBuffer | null {
  if (typeof d === 'string' || d instanceof ArrayBuffer) return d;
  if (ArrayBuffer.isView(d)) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
  return null;
}

function makeToken(sdk: Sdk): string {
  const now = sdk.nowInSec();
  return new sdk.SkyWayAuthToken({
    jti: sdk.uuidV4(),
    iat: now,
    exp: now + 24 * 3600,
    version: 3,
    scope: {
      appId: APP_ID,
      turn: { enabled: true },
      rooms: [
        {
          name: 'halcyon-*',
          methods: ['create', 'close', 'updateMetadata'],
          member: { name: '*', methods: ['publish', 'subscribe', 'updateMetadata'] },
        },
      ],
    },
  }).encode(SECRET);
}

/**
 * Connect to SkyWay room `code`. `create`: this browser opens the room and
 * hosts it. Refusals arrive as the relay's own `error` messages.
 */
export function skywayTransport(code: string, create: boolean): Transport {
  let closed = false;
  let cleanup: () => Promise<void> = async () => {};
  const t: Transport = {
    kind: 'skyway',
    send: () => {},
    close: () => {
      if (closed) return;
      closed = true;
      void cleanup().catch(() => {});
    },
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => {},
  };
  const fail = (code?: 'badRoom' | 'full') => {
    if (closed) return;
    if (code) t.onMessage(JSON.stringify({ t: 'error', code }));
    t.close();
    t.onClose();
  };

  void (async () => {
    const sdk = await import('@skyway-sdk/room');
    const context = await sdk.SkyWayContext.Create(makeToken(sdk));
    const name = `halcyon-${code}`;
    const room = create
      ? await sdk.SkyWayRoom.FindOrCreate(context, { type: 'p2p', name })
      : await sdk.SkyWayRoom.Find(context, { name }, { type: 'p2p' }).catch(() => null);
    if (!room) return fail('badRoom');
    if (create && room.members.some((m) => m.name === HOST_NAME)) {
      await context.dispose();
      return fail('badRoom');
    }
    const me = await room.join(create ? { name: HOST_NAME } : {});
    cleanup = async () => {
      if (create) await room.close().catch(() => {});
      else await me.leave().catch(() => {});
      await room.dispose().catch(() => {});
      context.dispose();
    };
    if (closed) return cleanup();
    window.addEventListener('pagehide', () => t.close(), { once: true });
    if (create) host(sdk, room, me);
    else guest(sdk, room, me);
  })().catch((e) => {
    console.warn('[skyway]', e);
    fail();
  });

  type Me = LocalP2PRoomMember;
  type Publication = RoomPublication;

  /** Subscribe to every data publication (now and later) that `want` accepts. */
  function subscribeWhere(room: P2PRoom, me: Me, want: (p: Publication) => boolean, onData: (p: Publication, d: Data) => void): void {
    const seen = new Set<string>();
    const sub = async (p: Publication) => {
      if (seen.has(p.id) || p.publisher.id === me.id || p.contentType !== 'data' || !want(p)) return;
      seen.add(p.id);
      const { stream } = await me.subscribe(p.id);
      (stream as RemoteDataStream).onData.add((d) => onData(p, d));
    };
    room.onStreamPublished.add(({ publication }) => void sub(publication).catch((e) => console.warn('[skyway] subscribe', e)));
    for (const p of room.publications) void sub(p).catch((e) => console.warn('[skyway] subscribe', e));
  }

  function guest(sdk: Sdk, room: P2PRoom, me: Me): void {
    void (async () => {
      const out = await sdk.SkyWayStreamFactory.createDataStream();
      await me.publish(out, { metadata: HOST_NAME });
      let open = false;
      t.send = (d) => {
        if (open && !closed) out.write(d);
      };
      subscribeWhere(
        room,
        me,
        (p) => p.publisher.name === HOST_NAME && p.metadata === me.id,
        (_p, d) => {
          const m = toPayload(d);
          if (m === null || closed) return;
          if (m === ACK) {
            if (!open) {
              open = true;
              t.onOpen();
            }
          } else if (m === BYE) fail();
          else if (m !== SYN) t.onMessage(m);
        },
      );
      room.onMemberLeft.add(({ member }) => {
        if (member.name === HOST_NAME) fail();
      });
      room.onClosed.add(() => fail());
      const started = performance.now();
      const syn = window.setInterval(() => {
        if (open || closed) return window.clearInterval(syn);
        if (performance.now() - started > JOIN_TIMEOUT_MS) {
          window.clearInterval(syn);
          return fail('badRoom');
        }
        out.write(SYN);
      }, SYN_EVERY_MS);
    })().catch((e) => {
      console.warn('[skyway]', e);
      fail();
    });
  }

  function host(sdk: Sdk, room: P2PRoom, me: Me): void {
    const core = new RoomCore(code, Math.random);
    interface Guest {
      conn: Conn | null;
      out: LocalDataStream | null;
      heard: number;
    }
    const guests = new Map<string, Guest>();
    const drop = (id: string) => {
      const g = guests.get(id);
      if (!g) return;
      guests.delete(id);
      if (g.conn) core.close(g.conn);
      try {
        g.out?.write(BYE);
      } catch {
        /* gone */
      }
    };
    const add = async (id: string) => {
      if (id === me.id || guests.has(id)) return;
      const g: Guest = { conn: null, out: null, heard: performance.now() };
      guests.set(id, g);
      const out = await sdk.SkyWayStreamFactory.createDataStream();
      await me.publish(out, { metadata: id });
      g.out = out;
    };
    room.onMemberJoined.add(({ member }) => void add(member.id).catch((e) => console.warn('[skyway] add', e)));
    room.onMemberLeft.add(({ member }) => drop(member.id));
    for (const m of room.members) void add(m.id).catch((e) => console.warn('[skyway] add', e));

    subscribeWhere(
      room,
      me,
      (p) => p.metadata === HOST_NAME,
      (p, d) => {
        const g = guests.get(p.publisher.id);
        const m = toPayload(d);
        if (!g || !g.out || m === null || closed) return;
        g.heard = performance.now();
        if (m === SYN) {
          g.out.write(ACK);
          if (!g.conn) {
            const out = g.out;
            g.conn = {
              send: (x) => out.write(x),
              close: () => drop(p.publisher.id),
            };
            core.open(g.conn);
          }
          return;
        }
        if (g.conn) core.message(g.conn, m);
      },
    );
    // players whose tab vanished without leaving (SkyWay's own keepalive is slower)
    const watch = window.setInterval(() => {
      if (closed) return window.clearInterval(watch);
      const now = performance.now();
      for (const [id, g] of guests) if (g.conn && now - g.heard > NET.skywaySilenceMs) drop(id);
    }, 1000);

    // this browser's own player: a loopback connection
    const local: Conn = {
      send: (x) => queueMicrotask(() => !closed && t.onMessage(x)),
      close: () => queueMicrotask(() => fail()),
    };
    t.send = (d) => {
      const copy = typeof d === 'string' ? d : d.slice(0);
      queueMicrotask(() => !closed && core.message(local, copy));
    };
    core.open(local);
    t.onOpen();
  }

  return t;
}
