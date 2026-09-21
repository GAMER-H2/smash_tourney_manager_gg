import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const convertFileSrcMock = vi.fn((path) => `http://asset.localhost/${path}`);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args) => invokeMock(...args),
  convertFileSrc: (...args) => convertFileSrcMock(...args),
}));

const WebcamPanel = (await import("../src/components/WebcamPanel.vue")).default;

const VIRTUAL_CAM = { deviceId: "vcam", kind: "videoinput", label: "OBS Virtual Camera" };
const CAPTURE_CARD = { deviceId: "card", kind: "videoinput", label: "USB Capture HDMI" };

function fakeStream() {
  return { getTracks: () => [{ stop: vi.fn() }] };
}

function setDevices(devices) {
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue(devices);
}

beforeEach(() => {
  invokeMock.mockReset();
  convertFileSrcMock.mockClear();

  invokeMock.mockImplementation((command, args) => {
    if (command === "get_platform") return "windows";
    if (command === "allow_overlay_layout_path") return `C:\\resolved\\${args.path}`;
    throw new Error(`unexpected command ${command}`);
  });

  // jsdom has no media stack at all: without these the component's own
  // stall-detection retries would run their full timeout budget on every test.
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
    configurable: true,
    get: () => 1920,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
    configurable: true,
    get: () => 1080,
  });

  globalThis.navigator.mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mountPanel(props = {}) {
  const wrapper = mount(WebcamPanel, {
    props: { cameraId: "", sourceMode: "auto", overlayUrl: "", ...props },
  });
  await flushPromises();
  return wrapper;
}

describe("preview source auto-detection", () => {
  it("prefers the OBS Virtual Camera when the per-user registration took", async () => {
    setDevices([CAPTURE_CARD, VIRTUAL_CAM]);
    const wrapper = await mountPanel({ overlayUrl: "http://localhost:8080/layout.html" });

    const picked = wrapper.emitted("update:cameraId");
    expect(picked.at(-1)).toEqual(["vcam"]);
    expect(wrapper.text()).toContain("OBS Virtual Camera");
    // The virtual camera feed already has the overlay burned in; compositing a
    // second copy on top of it would be wrong.
    expect(wrapper.find("iframe").exists()).toBe(false);
  });

  it("falls back to the capture card and composites the layout when no virtual camera exists", async () => {
    setDevices([CAPTURE_CARD]);
    const wrapper = await mountPanel({ overlayUrl: "http://localhost:8080/layout.html" });

    expect(wrapper.emitted("update:cameraId").at(-1)).toEqual(["card"]);
    expect(wrapper.text()).toContain("Capture card + overlay");
    expect(wrapper.find("iframe").attributes("src")).toBe("http://localhost:8080/layout.html");
  });

  it("says why there is no picture when the fallback has no layout configured", async () => {
    setDevices([CAPTURE_CARD]);
    const wrapper = await mountPanel({ overlayUrl: "" });

    expect(wrapper.find("iframe").exists()).toBe(false);
    expect(wrapper.text()).toContain("No OBS Virtual Camera found");
  });

  it("honours an explicitly pinned mode over what was detected", async () => {
    setDevices([CAPTURE_CARD, VIRTUAL_CAM]);
    const wrapper = await mountPanel({
      sourceMode: "overlay",
      overlayUrl: "http://localhost:8080/layout.html",
    });

    expect(wrapper.find("iframe").exists()).toBe(true);
  });

  it("does not override a device the operator picked by hand", async () => {
    setDevices([CAPTURE_CARD, VIRTUAL_CAM]);
    const wrapper = await mountPanel();
    await flushPromises();

    await wrapper.find("select").setValue("card");
    await wrapper.setProps({ cameraId: "card" });
    await wrapper.find("button").trigger("click"); // Refresh
    await flushPromises();

    expect(wrapper.emitted("update:cameraId").at(-1)).toEqual(["card"]);
  });
});

describe("overlay layout resolution", () => {
  it("routes a local layout path through the asset protocol", async () => {
    setDevices([CAPTURE_CARD]);
    const wrapper = await mountPanel({ overlayUrl: "C:\\overlays\\index.html" });

    expect(invokeMock).toHaveBeenCalledWith("allow_overlay_layout_path", {
      path: "C:\\overlays\\index.html",
    });
    expect(convertFileSrcMock).toHaveBeenCalledWith("C:\\resolved\\C:\\overlays\\index.html");
    expect(wrapper.find("iframe").attributes("src")).toContain("asset.localhost");
  });

  it("strips the leading slash a file:// URL adds before a Windows drive letter", async () => {
    setDevices([CAPTURE_CARD]);
    await mountPanel({ overlayUrl: "file:///C:/overlays/index.html" });

    expect(invokeMock).toHaveBeenCalledWith("allow_overlay_layout_path", {
      path: "C:/overlays/index.html",
    });
  });

  it("frames an http layout URL directly without asking the backend", async () => {
    setDevices([CAPTURE_CARD]);
    await mountPanel({ overlayUrl: "http://localhost:8080/layout.html" });

    expect(invokeMock).not.toHaveBeenCalledWith(
      "allow_overlay_layout_path",
      expect.anything(),
    );
  });

  it("surfaces a layout the backend refused instead of showing a blank panel", async () => {
    setDevices([CAPTURE_CARD]);
    invokeMock.mockImplementation((command) => {
      if (command === "get_platform") return "windows";
      throw new Error("Overlay layout 'C:\\nope\\index.html' is not a file.");
    });

    const wrapper = await mountPanel({ overlayUrl: "C:\\nope\\index.html" });

    expect(wrapper.find("iframe").exists()).toBe(false);
    expect(wrapper.text()).toContain("Could not load overlay layout");
  });
});
