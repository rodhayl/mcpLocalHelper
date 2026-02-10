import * as si from 'systeminformation';
import { SystemProfile } from '../types/index.js';

export class SystemProfiler {
  async getSystemProfile(): Promise<SystemProfile> {
    const [osInfo, cpuInfo, memInfo, diskInfo, graphicsInfo] = await Promise.all([
      si.osInfo(),
      si.cpu(),
      si.mem(),
      si.fsSize(),
      si.graphics(),
    ]);

    const os = this.getOSFamily(osInfo.platform);
    const cpuCores = cpuInfo.cores || 1;
    const ramGB = Math.round(memInfo.total / 1024 ** 3);
    const ramBucket = this.bucketRAM(ramGB);

    const gpu = this.getGPUInfo(graphicsInfo);

    const mainDisk = diskInfo.find((d) => d.mount === '/' || d.mount === 'C:');
    const diskFreeGB = mainDisk ? Math.round(mainDisk.available / 1024 ** 3) : 0;
    const diskBucket = this.bucketDisk(diskFreeGB);

    return {
      os,
      cpu_cores: cpuCores,
      ram_gb_bucket: ramBucket,
      gpu: gpu.present
        ? {
            present: gpu.present,
            vendor: gpu.vendor as 'nvidia' | 'amd' | 'intel' | 'other',
            vram_gb_bucket: gpu.vram_gb_bucket as '2' | '4' | '8' | '16' | '24+',
          }
        : undefined,
      disk_free_gb_bucket: diskBucket,
    };
  }

  private getOSFamily(platform: string): string {
    const platformMap: Record<string, string> = {
      win32: 'windows',
      darwin: 'macos',
      linux: 'linux',
    };
    return platformMap[platform] || platform;
  }

  private bucketRAM(ramGB: number): '4' | '8' | '16' | '32+' {
    if (ramGB <= 4) return '4';
    if (ramGB <= 8) return '8';
    if (ramGB <= 16) return '16';
    return '32+';
  }

  private bucketDisk(diskGB: number): '50' | '100' | '250' | '500+' {
    if (diskGB <= 50) return '50';
    if (diskGB <= 100) return '100';
    if (diskGB <= 250) return '250';
    return '500+';
  }

  private getGPUInfo(graphicsInfo: {
    controllers?: Array<{ vram?: number | null; vendor?: string; model?: string }>;
  }): {
    present: boolean;
    vendor?: string;
    vram_gb_bucket?: string;
  } {
    const controllers = graphicsInfo.controllers || [];
    const gpu = controllers.find((c) => c.vram && c.vram > 0);

    if (!gpu) {
      return { present: false };
    }

    const vendor = this.getGPUVendor(gpu.vendor || gpu.model || '');
    const vramGB = Math.round((gpu.vram || 0) / 1024);
    const vramBucket = this.bucketVRAM(vramGB);

    return {
      present: true,
      vendor,
      vram_gb_bucket: vramBucket,
    };
  }

  private getGPUVendor(vendorString: string): 'nvidia' | 'amd' | 'intel' | 'other' {
    const lower = vendorString.toLowerCase();
    if (lower.includes('nvidia')) return 'nvidia';
    if (lower.includes('amd') || lower.includes('ati')) return 'amd';
    if (lower.includes('intel')) return 'intel';
    return 'other';
  }

  private bucketVRAM(vramGB: number): '2' | '4' | '8' | '16' | '24+' {
    if (vramGB <= 2) return '2';
    if (vramGB <= 4) return '4';
    if (vramGB <= 8) return '8';
    if (vramGB <= 16) return '16';
    return '24+';
  }

  getModelSuitability(profile: SystemProfile): {
    recommended: string[];
    heavy: string[];
    notRecommended: string[];
  } {
    const ramGB = parseInt(profile.ram_gb_bucket.replace('+', ''));
    const hasGPU = profile.gpu?.present || false;
    const vramGB = profile.gpu?.vram_gb_bucket
      ? parseInt(profile.gpu.vram_gb_bucket.replace('+', ''))
      : 0;

    const recommended: string[] = [];
    const heavy: string[] = [];
    const notRecommended: string[] = [];

    // Model recommendations based on hardware
    if (ramGB >= 32) {
      recommended.push('Llama 3.1 70B', 'CodeLlama 70B', 'Mistral Large');
    } else if (ramGB >= 16) {
      recommended.push('Llama 3.1 8B', 'CodeLlama 13B', 'Mistral 7B');
      heavy.push('Llama 3.1 70B');
    } else if (ramGB >= 8) {
      recommended.push('Llama 3.1 8B', 'CodeLlama 7B', 'Mistral 7B');
      heavy.push('Llama 3.1 70B', 'CodeLlama 13B');
    } else {
      recommended.push('Llama 3.1 3B', 'CodeLlama 3B');
      heavy.push('Llama 3.1 8B', 'CodeLlama 7B');
      notRecommended.push('Llama 3.1 70B', 'CodeLlama 13B');
    }

    if (hasGPU && vramGB >= 24) {
      recommended.push('Large Vision Models', 'Multimodal Models');
    } else if (hasGPU && vramGB >= 8) {
      recommended.push('Small Vision Models');
      heavy.push('Large Vision Models');
    } else {
      notRecommended.push('Vision Models', 'Multimodal Models');
    }

    return { recommended, heavy, notRecommended };
  }
}
