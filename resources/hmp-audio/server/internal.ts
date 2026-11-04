import type { HmpAudioDialoguePolicy, HmpAudioPlayOptions, HmpAudioPlayer } from "../types";

/** Absent on a host older than the dialogue policy. */
export interface NativeDialogue {
    readonly dialoguePolicy?: HmpAudioDialoguePolicy;
    setDialoguePolicy?(policy: Partial<HmpAudioDialoguePolicy>): boolean;
}

export interface NativeServerAudio<P extends HmpAudioPlayer> extends NativeDialogue {
    playSoundAt(event: string, x: number, y: number, z: number, options?: Omit<HmpAudioPlayOptions, "held">): number;
    playSoundOnPlayer(player: P, event: string, options?: Omit<HmpAudioPlayOptions, "held">): number;
    playSoundForPlayer(player: P, event: string, options?: Omit<HmpAudioPlayOptions, "range" | "held">): number;
    playSoundForAll(event: string, options?: Omit<HmpAudioPlayOptions, "range" | "held">): number;
    stopSound(soundId: number): boolean;
    stopEventFor(event: string): string;
    bankFor(event: string): string;
    loadBank(bank: string): void;
    unloadBank(bank: string): void;
}

export interface AudioConfig {
    aliases: Record<string, string>;
    defaultRange: number;
    maxActivePerOwner: number;
    oneShotHandleMs: number;
    enableCommands: boolean;
    command: string;
    dialogue: Partial<HmpAudioDialoguePolicy>;
}

export interface AudioEvents {
    emit(eventName: string, payload?: unknown): void;
}
