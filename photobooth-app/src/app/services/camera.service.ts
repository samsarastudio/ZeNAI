import { Injectable, inject } from '@angular/core';
import type { PhotoboothCameraConfig } from '../models/photobooth-config.model';
import { BoothConfigService } from './booth-config.service';
import { BoothLogService } from './booth-log.service';
import type { PbCameraResult, PbPaths } from '../../types/pb-api';

export interface CameraInitResult {
  previewBasePath: string;
  useWebcam: boolean;
  webcamDeviceId?: string | null;
  lastError?: string;
}

const INIT_TIMEOUT_MS = 10000;
const WEBCAM_TIMEOUT_MS = 12000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function summarizeConstraints(c: MediaStreamConstraints): unknown {
  try {
    return JSON.parse(JSON.stringify(c));
  } catch {
    return String(c);
  }
}

@Injectable({ providedIn: 'root' })
export class CameraService {
  private readonly booth = inject(BoothConfigService);
  private readonly log = inject(BoothLogService);

  normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
  }

  hasApi(): boolean {
    return typeof window !== 'undefined' && !!window.pbApi;
  }

  async getPaths(): Promise<PbPaths | undefined> {
    return window.pbApi?.getPaths();
  }

  /** List Canon SDK cameras (requires bridge). Does not leave a session open. */
  async listSdkCameras(): Promise<{ ok: boolean; cameras: string[]; error?: string }> {
    if (!this.hasApi()) {
      return { ok: false, cameras: [], error: 'Not running in Electron.' };
    }
    const paths = await window.pbApi!.getPaths();
    if (!paths.hasBridge) {
      await this.log.warn('camera', 'listSdkCameras: no bridge');
      return { ok: false, cameras: [], error: 'EDS bridge .exe not placed next to app.' };
    }
    await this.closeSession();
    try {
      const initR = await withTimeout(
        window.pbApi!.cameraInvoke({ cmd: 'init' }),
        INIT_TIMEOUT_MS,
        'SDK init',
      );
      if (!initR.ok) {
        const error = initR.msg ?? String(initR.err ?? 'init');
        await this.log.error('camera', 'listSdkCameras init failed', error);
        return { ok: false, cameras: [], error };
      }
      const listR = await withTimeout(
        window.pbApi!.cameraInvoke({ cmd: 'list' }),
        INIT_TIMEOUT_MS,
        'SDK list',
      );
      if (!listR.ok) {
        const error = listR.msg ?? String(listR.err ?? 'list');
        await this.log.error('camera', 'listSdkCameras list failed', error);
        return { ok: false, cameras: [], error };
      }
      await this.log.info('camera', 'listSdkCameras ok', { count: (listR.cameras ?? []).length });
      return { ok: true, cameras: listR.cameras ?? [] };
    } catch (e) {
      await this.log.error('camera', 'listSdkCameras exception', String(e));
      return { ok: false, cameras: [], error: String(e) };
    }
  }

  async initAndOpenFirstCamera(): Promise<CameraInitResult> {
    const cameraCfg = this.booth.camera();
    await this.log.info('camera', 'initAndOpenFirstCamera start', {
      source: cameraCfg.source,
      sdkCameraIndex: cameraCfg.sdkCameraIndex,
      hasWebcamDeviceId: !!cameraCfg.webcamDeviceId,
    });
    if (!this.hasApi()) {
      await this.log.warn('camera', 'init: no pbApi — forcing webcam');
      return { previewBasePath: '', useWebcam: true, webcamDeviceId: cameraCfg.webcamDeviceId };
    }
    try {
      const result = await withTimeout(
        this.initCameraInner(cameraCfg),
        INIT_TIMEOUT_MS,
        'Camera init',
      );
      await this.log.info('camera', 'initAndOpenFirstCamera result', {
        useWebcam: result.useWebcam,
        lastError: result.lastError ?? null,
      });
      return result;
    } catch (e) {
      await this.log.error('camera', 'initAndOpenFirstCamera timed out / failed', String(e));
      const paths = await window.pbApi!.getPaths().catch(() => undefined);
      const previewFile = paths
        ? `${this.normalizePath(paths.captureDir)}/_live_preview.jpg`
        : '';
      return {
        previewBasePath: previewFile,
        useWebcam: true,
        webcamDeviceId: cameraCfg.webcamDeviceId,
        lastError: cameraCfg.source === 'webcam' ? undefined : String(e),
      };
    }
  }

  private async initCameraInner(cameraCfg: PhotoboothCameraConfig): Promise<CameraInitResult> {
    const paths = await window.pbApi!.getPaths();
    const previewFile = `${this.normalizePath(paths.captureDir)}/_live_preview.jpg`;
    const useSdk = this.shouldUseSdk(cameraCfg, paths);
    await this.log.info('camera', 'init path decision', {
      useSdk,
      hasBridge: paths.hasBridge,
      source: cameraCfg.source,
      captureDir: paths.captureDir,
      logFile: paths.logFile,
    });

    if (!useSdk) {
      return {
        previewBasePath: previewFile,
        useWebcam: true,
        webcamDeviceId: cameraCfg.webcamDeviceId,
        ...(cameraCfg.source === 'sdk'
          ? {
              lastError: paths.hasBridge
                ? 'Canon SDK forced but bridge unavailable'
                : 'EDS bridge .exe not placed next to app',
            }
          : {}),
      };
    }

    await this.closeSession();
    const initR = await window.pbApi!.cameraInvoke({ cmd: 'init' });
    if (!initR.ok) {
      const lastError = initR.msg ?? String(initR.err ?? 'init');
      await this.log.error('camera', 'SDK init failed — webcam fallback', lastError);
      return {
        previewBasePath: previewFile,
        useWebcam: true,
        webcamDeviceId: cameraCfg.webcamDeviceId,
        lastError: cameraCfg.source === 'webcam' ? undefined : lastError,
      };
    }
    const index = Math.max(0, Math.floor(cameraCfg.sdkCameraIndex ?? 0));
    const openR = await window.pbApi!.cameraInvoke({ cmd: 'open', index });
    if (!openR.ok) {
      const lastError = openR.msg ?? String(openR.err ?? 'open');
      await this.log.error('camera', 'SDK open failed — webcam fallback', {
        index,
        lastError,
      });
      return {
        previewBasePath: previewFile,
        useWebcam: true,
        webcamDeviceId: cameraCfg.webcamDeviceId,
        lastError,
      };
    }
    await this.log.info('camera', 'SDK camera opened', { index });
    return { previewBasePath: previewFile, useWebcam: false };
  }

  private shouldUseSdk(cameraCfg: PhotoboothCameraConfig, paths: PbPaths): boolean {
    if (cameraCfg.source === 'webcam') return false;
    if (cameraCfg.source === 'sdk') return paths.hasBridge;
    return paths.hasBridge;
  }

  /**
   * Open a system camera with progressive constraint fallbacks.
   * Tablets often reject 1080p + facingMode; bare `video: true` is the last resort.
   */
  async openWebcamStream(preferredDeviceId?: string | null): Promise<{
    stream: MediaStream | null;
    error?: string;
  }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      await this.log.error('camera', 'getUserMedia API missing');
      return { stream: null, error: 'Camera API not available in this environment.' };
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      await this.log.info('camera', 'enumerateDevices', {
        videoInputCount: cams.length,
        labels: cams.map((c, i) => c.label || `(unnamed ${i})`),
      });
    } catch (e) {
      await this.log.warn('camera', 'enumerateDevices failed', String(e));
    }

    const attempts: MediaStreamConstraints[] = [];
    if (preferredDeviceId) {
      attempts.push({
        audio: false,
        video: {
          deviceId: { exact: preferredDeviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      attempts.push({
        audio: false,
        video: { deviceId: { ideal: preferredDeviceId } },
      });
    }
    attempts.push({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    });
    attempts.push({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
    });
    attempts.push({ audio: false, video: true });

    let lastErr = 'No camera opened.';
    for (let i = 0; i < attempts.length; i++) {
      const constraints = attempts[i];
      await this.log.info('camera', `getUserMedia attempt ${i + 1}/${attempts.length}`, {
        preferredDeviceId: preferredDeviceId || null,
        constraints: summarizeConstraints(constraints),
      });
      try {
        const stream = await withTimeout(
          navigator.mediaDevices.getUserMedia(constraints),
          WEBCAM_TIMEOUT_MS,
          'Webcam',
        );
        const track = stream.getVideoTracks()[0];
        await this.log.info('camera', 'getUserMedia success', {
          attempt: i + 1,
          trackLabel: track?.label,
          settings: track?.getSettings?.(),
        });
        return { stream };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        const name = e instanceof DOMException ? e.name : undefined;
        await this.log.warn('camera', `getUserMedia attempt ${i + 1} failed`, {
          name,
          message: lastErr,
        });
      }
    }
    await this.log.error('camera', 'all getUserMedia attempts failed', lastErr);
    return { stream: null, error: lastErr };
  }

  async previewFrame(outPath: string): Promise<PbCameraResult> {
    return window.pbApi!.cameraInvoke({
      cmd: 'preview',
      path: this.normalizePath(outPath),
    });
  }

  async capture(outPath: string): Promise<PbCameraResult> {
    await this.log.info('camera', 'capture start', { outPath });
    const res = await window.pbApi!.cameraInvoke({
      cmd: 'capture',
      path: this.normalizePath(outPath),
    });
    if (!res.ok) {
      await this.log.error('camera', 'capture failed', { err: res.err, msg: res.msg });
    } else {
      await this.log.info('camera', 'capture ok', { path: res.path });
    }
    return res;
  }

  async closeSession(): Promise<void> {
    if (!this.hasApi()) return;
    try {
      // Stop EVF + close session. Main process then shuts down the bridge so the
      // camera is not held warm — without racing init/open on the same turn.
      await withTimeout(window.pbApi!.cameraInvoke({ cmd: 'close' }), 3000, 'SDK close');
    } catch (e) {
      await this.log.warn('camera', 'closeSession', String(e));
    }
  }
}
