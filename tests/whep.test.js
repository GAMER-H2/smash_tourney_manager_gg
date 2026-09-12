import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeWhepUrl,
  parseIceServers,
  resolveWhepSessionUrl,
  WhepClient,
} from "../src/lib/whep";

const originalPeerConnection = globalThis.RTCPeerConnection;

afterEach(() => {
  globalThis.RTCPeerConnection = originalPeerConnection;
});

describe("WHEP URL handling", () => {
  it("normalizes relative endpoint URLs against the application URL", () => {
    expect(normalizeWhepUrl("/live/desk/whep", "http://localhost:1420/settings")).toBe(
      "http://localhost:1420/live/desk/whep",
    );
  });

  it("rejects empty, invalid, and non-HTTP endpoints", () => {
    expect(() => normalizeWhepUrl("", "http://localhost/")).toThrow("Enter a WHEP URL");
    expect(() => normalizeWhepUrl("http://[", "http://localhost/")).toThrow("not valid");
    expect(() => normalizeWhepUrl("rtsp://camera/live", "http://localhost/")).toThrow(
      "HTTP or HTTPS",
    );
  });

  it("resolves relative WHEP session locations from the response URL", () => {
    expect(
      resolveWhepSessionUrl("../session/abc", "http://mediamtx.local:8889/camera/whep"),
    ).toBe("http://mediamtx.local:8889/session/abc");
    expect(resolveWhepSessionUrl(null, "http://mediamtx.local/whep")).toBeNull();
  });
});

describe("WHEP client lifecycle", () => {
  it("creates a session from an SDP answer and deletes it when closed", async () => {
    class MockPeerConnection {
      constructor(configuration) {
        this.configuration = configuration;
        this.iceGatheringState = "complete";
        this.connectionState = "connecting";
        this.localDescription = null;
        this.remoteDescription = null;
        this.listeners = new Map();
      }

      addTransceiver() {}
      addEventListener(name, callback) {
        this.listeners.set(name, callback);
      }
      async createOffer() {
        return { type: "offer", sdp: "v=0\\r\\n" };
      }
      async setLocalDescription(offer) {
        this.localDescription = offer;
      }
      async setRemoteDescription(answer) {
        this.remoteDescription = answer;
      }
      close() {
        this.connectionState = "closed";
      }
    }

    globalThis.RTCPeerConnection = MockPeerConnection;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (name) => (name === "Link" ? '<stun:localhost>; rel="ice-server"' : null) },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        url: "http://127.0.0.1:8889/preview/whep",
        headers: { get: (name) => (name === "Location" ? "/preview/session/one" : null) },
        text: async () => "v=0\\r\\n",
      })
      .mockResolvedValueOnce({ ok: true });
    const video = { srcObject: null };
    const client = new WhepClient({
      endpoint: "http://127.0.0.1:8889/preview/whep",
      videoElement: video,
      fetchImpl: fetchMock,
    });

    await client.connect();
    expect(fetchMock.mock.calls[0][1].method).toBe("OPTIONS");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      body: "v=0\\r\\n",
    });
    expect(client.peerConnection.configuration).toEqual({
      iceServers: [{ urls: "stun:localhost" }],
    });
    expect(client.peerConnection.remoteDescription).toEqual({
      type: "answer",
      sdp: "v=0\\r\\n",
    });

    client.close();
    expect(fetchMock.mock.calls[2]).toEqual([
      "http://127.0.0.1:8889/preview/session/one",
      { method: "DELETE" },
    ]);
  });
});

describe("WHEP ICE server parsing", () => {
  it("parses STUN and authenticated TURN links", () => {
    const links = [
      '<stun:stun.example.net>; rel="ice-server"',
      '<turn:turn.example.net?transport=udp>; rel="ice-server"; username="desk"; credential="a,b"',
    ].join(", ");

    expect(parseIceServers(links)).toEqual([
      { urls: "stun:stun.example.net" },
      {
        urls: "turn:turn.example.net?transport=udp",
        username: "desk",
        credential: "a,b",
      },
    ]);
  });

  it("ignores unrelated links and missing headers", () => {
    expect(parseIceServers('<https://example.test/docs>; rel="help"')).toEqual([]);
    expect(parseIceServers(null)).toEqual([]);
  });
});
