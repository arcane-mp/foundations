import type { HmpBlipNativeIcons, HmpBlipPlayer } from "../types";

export interface BlipsConfig {
    defaultTtl: number;
    maxTtl: number;
    maxMarkersPerResource: number;
    showAllPlayers: boolean;
    houseTint: boolean;
    playerBlipScale: number;
    hideBaseIcon: boolean;
    nativeIcons: HmpBlipNativeIcons;
    enableCommands: boolean;
    command: string;
}

export interface BlipEvents {
    emit(eventName: string, payload?: unknown): void;
    emitAllClients(eventName: string, payload?: unknown): void;
}

export interface BlipLogger {
    warn(...args: unknown[]): unknown;
    error(...args: unknown[]): unknown;
}

export interface BlipCore<P extends HmpBlipPlayer> {
    groups: {
        has(player: P | number, key: string, minimumGrade?: number): Promise<boolean>;
    };
}
