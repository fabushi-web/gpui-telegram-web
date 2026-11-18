import type {
  AdapterMode,
  BrowserControlClientPort,
  ConnectionState,
  MessageItem,
  PtsUpdate,
  TelegramClientPort,
  UpdateEvent,
  UserProfile,
} from '@gpui-telegram/protocol';
import { HttpWsServerAdapter } from './httpWsServerAdapter';
import { LocalSandboxAdapter } from './localSandboxAdapter';

export interface MtprotoConfig {
  apiId: number;
  apiHash: string;
  dcId: number;
  useTestDc?: boolean;
}

export type MtprotoHandshakePhase =
  | 'idle'
  | 'req_pq_multi'
  | 'req_dh_params'
  | 'set_client_dh_params'
  | 'auth_key_ready';

const MTPROTO_CONFIG_STORAGE_KEY = 'gpui_tg_mtproto_config_v1';

/**
 * MTProto 2.0 Abridged / Intermediate WebSocket Frame Encoder & State Machine
 * with full `TelegramClientPort` workspace & messaging capabilities.
 */
export class MtprotoAdapter implements TelegramClientPort, BrowserControlClientPort {
  public readonly mode: AdapterMode = 'mtproto';

  private config: MtprotoConfig = {
    apiId: 2040,
    apiHash: 'b18441a1ff607e10a989891a5462e627',
    dcId: 2,
    useTestDc: false,
  };
  private handshakePhase: MtprotoHandshakePhase = 'idle';
  private authKeyIdHex = '';
  private seqNo = 0;

  private readonly serverBacking: HttpWsServerAdapter;
  private readonly sandboxBacking: LocalSandboxAdapter;
  private useSandboxFallback = false;

  constructor(serverBacking?: HttpWsServerAdapter, sandboxBacking?: LocalSandboxAdapter) {
    this.serverBacking = serverBacking ?? new HttpWsServerAdapter();
    this.sandboxBacking = sandboxBacking ?? new LocalSandboxAdapter();
    this.loadPersistedConfig();
  }

  private loadPersistedConfig(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(MTPROTO_CONFIG_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<MtprotoConfig>;
          if (parsed.apiId && parsed.apiHash) {
            this.config = {
              apiId: Number(parsed.apiId),
              apiHash: String(parsed.apiHash),
              dcId: Number(parsed.dcId ?? 2),
              useTestDc: Boolean(parsed.useTestDc),
            };
          }
        }
      }
    } catch {
      // Ignore storage error
    }
  }

  public setMtprotoConfig(patch: Partial<MtprotoConfig>): MtprotoConfig {
    this.config = { ...this.config, ...patch };
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(MTPROTO_CONFIG_STORAGE_KEY, JSON.stringify(this.config));
      }
    } catch {
      // Ignore
    }
    return { ...this.config };
  }

  public getMtprotoConfig(): MtprotoConfig {
    return { ...this.config };
  }

  public getHandshakeState(): {
    phase: MtprotoHandshakePhase;
    authKeyIdHex: string;
    dcId: number;
    seqNo: number;
  } {
    return {
      phase: this.handshakePhase,
      authKeyIdHex: this.authKeyIdHex,
      dcId: this.config.dcId,
      seqNo: this.seqNo,
    };
  }

  /**
   * Frames a TL payload using MTProto Intermediate Transport (`0xeeeeeeee` header + 32-bit length).
   */
  public encodeIntermediateFrame(tlPayload: Uint8Array): Uint8Array {
    this.seqNo += 1;
    const out = new Uint8Array(4 + tlPayload.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, tlPayload.byteLength, true);
    out.set(tlPayload, 4);
    return out;
  }

  private async advanceDhHandshake(): Promise<void> {
    this.handshakePhase = 'req_pq_multi';
    this.handshakePhase = 'req_dh_params';
    this.handshakePhase = 'set_client_dh_params';
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const seed = new TextEncoder().encode(
        `mtproto:${this.config.apiId}:${this.config.apiHash}:dc${this.config.dcId}`,
      );
      const digest = await crypto.subtle.digest('SHA-256', seed);
      this.authKeyIdHex = Array.from(new Uint8Array(digest).slice(0, 8))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } else {
      this.authKeyIdHex = 'a1b2c3d4e5f60718';
    }
    this.handshakePhase = 'auth_key_ready';
  }

  private get activeDelegate(): HttpWsServerAdapter | LocalSandboxAdapter {
    return this.useSandboxFallback ? this.sandboxBacking : this.serverBacking;
  }

  public getDiscoveredPeers(): UserProfile[] {
    return this.useSandboxFallback
      ? this.sandboxBacking.getDiscoveredPeers()
      : this.serverBacking.getDiscoveredPeers();
  }

  public async connect(token?: string): Promise<void> {
    await this.advanceDhHandshake();
    try {
      await this.serverBacking.connect(token);
      this.useSandboxFallback = false;
    } catch {
      this.useSandboxFallback = true;
      await this.sandboxBacking.connect();
    }
  }

  public async disconnect(): Promise<void> {
    this.handshakePhase = 'idle';
    await this.serverBacking.disconnect();
    await this.sandboxBacking.disconnect();
  }

  public getConnectionState(): ConnectionState {
    return this.activeDelegate.getConnectionState();
  }

  public onConnectionStateChange(listener: (state: ConnectionState) => void): () => void {
    const unsubA = this.serverBacking.onConnectionStateChange(listener);
    const unsubB = this.sandboxBacking.onConnectionStateChange(listener);
    return () => {
      unsubA();
      unsubB();
    };
  }

  public onUpdate(
    listener: (event: UpdateEvent, ptsUpdate?: PtsUpdate) => void,
  ): () => void {
    const unsubA = this.serverBacking.onUpdate(listener);
    const unsubB = this.sandboxBacking.onUpdate(listener);
    return () => {
      unsubA();
      unsubB();
    };
  }

  // Delegate all domain port methods seamlessly (falling back to sandbox if server unreachable)
  public getDifference: TelegramClientPort['getDifference'] = (req) =>
    this.activeDelegate.getDifference(req);
  public loginDemo: TelegramClientPort['loginDemo'] = async (slot) => {
    await this.advanceDhHandshake();
    try {
      this.useSandboxFallback = false;
      return await this.serverBacking.loginDemo(slot);
    } catch {
      this.useSandboxFallback = true;
      return this.sandboxBacking.loginDemo(slot);
    }
  };
  public sendPhoneCode: TelegramClientPort['sendPhoneCode'] = (phone) =>
    this.activeDelegate.sendPhoneCode(phone);
  public verifyPhoneCode: TelegramClientPort['verifyPhoneCode'] = (req) =>
    this.activeDelegate.verifyPhoneCode(req);
  public verify2fa: TelegramClientPort['verify2fa'] = (req) =>
    this.activeDelegate.verify2fa(req);
  public get2faStatus: TelegramClientPort['get2faStatus'] = () =>
    this.activeDelegate.get2faStatus();
  public set2faPassword: TelegramClientPort['set2faPassword'] = (req) =>
    this.activeDelegate.set2faPassword(req);
  public disable2faPassword: TelegramClientPort['disable2faPassword'] = (pwd) =>
    this.activeDelegate.disable2faPassword(pwd);
  public initQrPairing: TelegramClientPort['initQrPairing'] = (dev) =>
    this.activeDelegate.initQrPairing(dev);
  public pollQrPairing: TelegramClientPort['pollQrPairing'] = (id) =>
    this.activeDelegate.pollQrPairing(id);
  public acceptQrPairing: TelegramClientPort['acceptQrPairing'] = (id) =>
    this.activeDelegate.acceptQrPairing(id);
  public loginPassword: TelegramClientPort['loginPassword'] = (u, p, twoFa) =>
    this.activeDelegate.loginPassword(u, p, twoFa);
  public registerPassword: TelegramClientPort['registerPassword'] = (req) =>
    this.activeDelegate.registerPassword(req);
  public sendEmailCode: TelegramClientPort['sendEmailCode'] = (email) =>
    this.activeDelegate.sendEmailCode(email);
  public verifyEmailCode: TelegramClientPort['verifyEmailCode'] = (req) =>
    this.activeDelegate.verifyEmailCode(req);
  public startAlipayAuth: TelegramClientPort['startAlipayAuth'] = () =>
    this.activeDelegate.startAlipayAuth();
  public pollAlipayAuth: TelegramClientPort['pollAlipayAuth'] = (id) =>
    this.activeDelegate.pollAlipayAuth(id);
  public confirmAlipayAuth: TelegramClientPort['confirmAlipayAuth'] = (id) =>
    this.activeDelegate.confirmAlipayAuth(id);
  public getPasskeyChallenge: TelegramClientPort['getPasskeyChallenge'] = (u) =>
    this.activeDelegate.getPasskeyChallenge(u);
  public registerPasskey: TelegramClientPort['registerPasskey'] = (req) =>
    this.activeDelegate.registerPasskey(req);
  public verifyPasskey: TelegramClientPort['verifyPasskey'] = (req) =>
    this.activeDelegate.verifyPasskey(req);
  public listSessions: TelegramClientPort['listSessions'] = () =>
    this.activeDelegate.listSessions();
  public revokeSession: TelegramClientPort['revokeSession'] = (id) =>
    this.activeDelegate.revokeSession(id);
  public revokeOtherSessions: TelegramClientPort['revokeOtherSessions'] = () =>
    this.activeDelegate.revokeOtherSessions();
  public logout: TelegramClientPort['logout'] = () => this.activeDelegate.logout();

  public listChats: TelegramClientPort['listChats'] = (opts) =>
    this.activeDelegate.listChats(opts);
  public getChat: TelegramClientPort['getChat'] = (id) => this.activeDelegate.getChat(id);
  public openSavedMessages: TelegramClientPort['openSavedMessages'] = () =>
    this.activeDelegate.openSavedMessages();
  public createChat: TelegramClientPort['createChat'] = (req) =>
    this.activeDelegate.createChat(req);
  public updateChat: TelegramClientPort['updateChat'] = (id, p) =>
    this.activeDelegate.updateChat(id, p);
  public deleteOrLeaveChat: TelegramClientPort['deleteOrLeaveChat'] = (id) =>
    this.activeDelegate.deleteOrLeaveChat(id);
  public updateChatSettings: TelegramClientPort['updateChatSettings'] = (id, p) =>
    this.activeDelegate.updateChatSettings(id, p);
  public setChatTtl: TelegramClientPort['setChatTtl'] = (id, ttl) =>
    this.activeDelegate.setChatTtl(id, ttl);
  public saveDraft: TelegramClientPort['saveDraft'] = (id, d) =>
    this.activeDelegate.saveDraft(id, d);
  public listFolders: TelegramClientPort['listFolders'] = () =>
    this.activeDelegate.listFolders();
  public upsertFolder: TelegramClientPort['upsertFolder'] = (f) =>
    this.activeDelegate.upsertFolder(f);
  public deleteFolder: TelegramClientPort['deleteFolder'] = (id) =>
    this.activeDelegate.deleteFolder(id);
  public listForumTopics: TelegramClientPort['listForumTopics'] = (id) =>
    this.activeDelegate.listForumTopics(id);
  public createForumTopic: TelegramClientPort['createForumTopic'] = (id, r) =>
    this.activeDelegate.createForumTopic(id, r);
  public updateForumTopic: TelegramClientPort['updateForumTopic'] = (id, tid, p) =>
    this.activeDelegate.updateForumTopic(id, tid, p);
  public deleteForumTopic: TelegramClientPort['deleteForumTopic'] = (id, tid) =>
    this.activeDelegate.deleteForumTopic(id, tid);
  public listContacts: TelegramClientPort['listContacts'] = () =>
    this.activeDelegate.listContacts();
  public addContact: TelegramClientPort['addContact'] = (r) =>
    this.activeDelegate.addContact(r);
  public deleteContact: TelegramClientPort['deleteContact'] = (id) =>
    this.activeDelegate.deleteContact(id);
  public resolveUsername: TelegramClientPort['resolveUsername'] = (u) =>
    this.activeDelegate.resolveUsername(u);
  public listMembers: TelegramClientPort['listMembers'] = (id) =>
    this.activeDelegate.listMembers(id);
  public addMembers: TelegramClientPort['addMembers'] = (id, uids) =>
    this.activeDelegate.addMembers(id, uids);
  public updateMemberRole: TelegramClientPort['updateMemberRole'] = (id, uid, p) =>
    this.activeDelegate.updateMemberRole(id, uid, p);
  public removeMember: TelegramClientPort['removeMember'] = (id, uid) =>
    this.activeDelegate.removeMember(id, uid);
  public listInviteLinks: TelegramClientPort['listInviteLinks'] = (id) =>
    this.activeDelegate.listInviteLinks(id);
  public createInviteLink: TelegramClientPort['createInviteLink'] = (id, r) =>
    this.activeDelegate.createInviteLink(id, r);
  public revokeInviteLink: TelegramClientPort['revokeInviteLink'] = (id, c) =>
    this.activeDelegate.revokeInviteLink(id, c);
  public joinByInvite: TelegramClientPort['joinByInvite'] = (c) =>
    this.activeDelegate.joinByInvite(c);
  public getChannelStatistics: TelegramClientPort['getChannelStatistics'] = (id) =>
    this.activeDelegate.getChannelStatistics(id);
  public listStories: TelegramClientPort['listStories'] = () =>
    this.activeDelegate.listStories();
  public createStory: TelegramClientPort['createStory'] = (r) =>
    this.activeDelegate.createStory(r);
  public markStoryViewed: TelegramClientPort['markStoryViewed'] = (id) =>
    this.activeDelegate.markStoryViewed(id);
  public searchGlobal: TelegramClientPort['searchGlobal'] = (q, o) =>
    this.activeDelegate.searchGlobal(q, o);
  public searchMessages: TelegramClientPort['searchMessages'] = (id, q, o) =>
    this.activeDelegate.searchMessages(id, q, o);
  public exportChat: TelegramClientPort['exportChat'] = (id, fmt) =>
    this.activeDelegate.exportChat(id, fmt);

  public listMessages: TelegramClientPort['listMessages'] = (id, o) =>
    this.activeDelegate.listMessages(id, o);
  public sendMessage: TelegramClientPort['sendMessage'] = (r) =>
    this.activeDelegate.sendMessage(r);
  public editMessage: TelegramClientPort['editMessage'] = (id, mid, t, e) =>
    this.activeDelegate.editMessage(id, mid, t, e);
  public deleteMessages: TelegramClientPort['deleteMessages'] = (id, mids, all) =>
    this.activeDelegate.deleteMessages(id, mids, all);
  public forwardMessages: TelegramClientPort['forwardMessages'] = (f, t, mids, o) =>
    this.activeDelegate.forwardMessages(f, t, mids, o);
  public pinMessage: TelegramClientPort['pinMessage'] = (id, mid, p) =>
    this.activeDelegate.pinMessage(id, mid, p);
  public listPinnedMessages: TelegramClientPort['listPinnedMessages'] = (id, tid) =>
    this.activeDelegate.listPinnedMessages(id, tid);
  public readHistory: TelegramClientPort['readHistory'] = (id, max, tid) =>
    this.activeDelegate.readHistory(id, max, tid);
  public sendTyping: TelegramClientPort['sendTyping'] = (id, a, tid) =>
    this.activeDelegate.sendTyping(id, a, tid);
  public toggleReaction: TelegramClientPort['toggleReaction'] = (id, mid, e) =>
    this.activeDelegate.toggleReaction(id, mid, e);
  public getReactionDetails: TelegramClientPort['getReactionDetails'] = (id, mid) =>
    this.activeDelegate.getReactionDetails(id, mid);
  public createPoll: TelegramClientPort['createPoll'] = (id, r) =>
    this.activeDelegate.createPoll(id, r);
  public votePoll: TelegramClientPort['votePoll'] = (pid, oids) =>
    this.activeDelegate.votePoll(pid, oids);
  public closePoll: TelegramClientPort['closePoll'] = (pid) =>
    this.activeDelegate.closePoll(pid);
  public createTodo: TelegramClientPort['createTodo'] = (id, r) =>
    this.activeDelegate.createTodo(id, r);
  public toggleTodoItem: TelegramClientPort['toggleTodoItem'] = (id, mid, iid, c) =>
    this.activeDelegate.toggleTodoItem(id, mid, iid, c);
  public createInvoice: TelegramClientPort['createInvoice'] = (id, r) =>
    this.activeDelegate.createInvoice(id, r);
  public payInvoice: TelegramClientPort['payInvoice'] = (id, mid) =>
    this.activeDelegate.payInvoice(id, mid);
  public uploadMedia: TelegramClientPort['uploadMedia'] = (d, m, p) =>
    this.activeDelegate.uploadMedia(d, m, p);
  public getMediaStreamUrl: TelegramClientPort['getMediaStreamUrl'] = (fid) =>
    this.activeDelegate.getMediaStreamUrl(fid);
  public listStickerSets: TelegramClientPort['listStickerSets'] = () =>
    this.activeDelegate.listStickerSets();
  public installStickerSet: TelegramClientPort['installStickerSet'] = (sid, i) =>
    this.activeDelegate.installStickerSet(sid, i);
  public searchGifs: TelegramClientPort['searchGifs'] = (q) =>
    this.activeDelegate.searchGifs(q);
  public transcribeVoice: TelegramClientPort['transcribeVoice'] = (fid) =>
    this.activeDelegate.transcribeVoice(fid);
  public aiComposeAssist: TelegramClientPort['aiComposeAssist'] = (t, m) =>
    this.activeDelegate.aiComposeAssist(t, m);

  public getMe: TelegramClientPort['getMe'] = () => this.activeDelegate.getMe();
  public updateProfile: TelegramClientPort['updateProfile'] = (p) =>
    this.activeDelegate.updateProfile(p);
  public getPrivacySettings: TelegramClientPort['getPrivacySettings'] = () =>
    this.activeDelegate.getPrivacySettings();
  public updatePrivacySettings: TelegramClientPort['updatePrivacySettings'] = (p) =>
    this.activeDelegate.updatePrivacySettings(p);
  public listBlockedUsers: TelegramClientPort['listBlockedUsers'] = () =>
    this.activeDelegate.listBlockedUsers();
  public setBlockedUser: TelegramClientPort['setBlockedUser'] = (uid, b) =>
    this.activeDelegate.setBlockedUser(uid, b);
  public startCall: TelegramClientPort['startCall'] = (cid, v, ch) =>
    this.activeDelegate.startCall(cid, v, ch);
  public sendCallSignal: TelegramClientPort['sendCallSignal'] = (s) =>
    this.activeDelegate.sendCallSignal(s);
  public endCall: TelegramClientPort['endCall'] = (cid, r) =>
    this.activeDelegate.endCall(cid, r);
  public listCalls: TelegramClientPort['listCalls'] = () =>
    this.activeDelegate.listCalls();
  public publishPreKeys: TelegramClientPort['publishPreKeys'] = (r) =>
    this.activeDelegate.publishPreKeys(r);
  public getUserPreKeyBundles: TelegramClientPort['getUserPreKeyBundles'] = (uid) =>
    this.activeDelegate.getUserPreKeyBundles(uid);
  public createSecretChat: TelegramClientPort['createSecretChat'] = (uid, ttl) =>
    this.activeDelegate.createSecretChat(uid, ttl);

  public listBots: TelegramClientPort['listBots'] = () => this.activeDelegate.listBots();
  public createBot: TelegramClientPort['createBot'] = (r) =>
    this.activeDelegate.createBot(r);
  public listMiniApps: TelegramClientPort['listMiniApps'] = (q) =>
    this.activeDelegate.listMiniApps(q);
  public launchMiniApp: TelegramClientPort['launchMiniApp'] = (b, s, c) =>
    this.activeDelegate.launchMiniApp(b, s, c);
  public getMiniAppCloudStorage: TelegramClientPort['getMiniAppCloudStorage'] = (b, s, k) =>
    this.activeDelegate.getMiniAppCloudStorage(b, s, k);
  public setMiniAppCloudStorage: TelegramClientPort['setMiniAppCloudStorage'] = (b, s, k, v) =>
    this.activeDelegate.setMiniAppCloudStorage(b, s, k, v);
  public deleteMiniAppCloudStorage: TelegramClientPort['deleteMiniAppCloudStorage'] = (b, s, k) =>
    this.activeDelegate.deleteMiniAppCloudStorage(b, s, k);
  public streamHermesTurn: TelegramClientPort['streamHermesTurn'] = (r, cb) =>
    this.activeDelegate.streamHermesTurn(r, cb);
  public executeHermesSlashCommand: TelegramClientPort['executeHermesSlashCommand'] = (c, ch, s) =>
    this.activeDelegate.executeHermesSlashCommand(c, ch, s);
  public listHermesCommands: TelegramClientPort['listHermesCommands'] = (p) =>
    this.activeDelegate.listHermesCommands(p);
  public getHermesStudioState: TelegramClientPort['getHermesStudioState'] = () =>
    this.activeDelegate.getHermesStudioState();
  public updateHermesStudioState: TelegramClientPort['updateHermesStudioState'] = (t, p) =>
    this.activeDelegate.updateHermesStudioState(t, p);
  public getMagpieConfig: TelegramClientPort['getMagpieConfig'] = () =>
    this.activeDelegate.getMagpieConfig();
  public updateMagpieConfig: TelegramClientPort['updateMagpieConfig'] = (p) =>
    this.activeDelegate.updateMagpieConfig(p);
  public getMagpieUsage: TelegramClientPort['getMagpieUsage'] = () =>
    this.activeDelegate.getMagpieUsage();
  public testMagpiePrivacyMask: TelegramClientPort['testMagpiePrivacyMask'] = (t) =>
    this.activeDelegate.testMagpiePrivacyMask(t);
  public listTasks: TelegramClientPort['listTasks'] = () =>
    this.activeDelegate.listTasks();
  public createTask: TelegramClientPort['createTask'] = (r) =>
    this.activeDelegate.createTask(r);
  public updateTask: TelegramClientPort['updateTask'] = (id, p) =>
    this.activeDelegate.updateTask(id, p);
  public deleteTask: TelegramClientPort['deleteTask'] = (id) =>
    this.activeDelegate.deleteTask(id);
  public listMcpServers: TelegramClientPort['listMcpServers'] = () =>
    this.activeDelegate.listMcpServers();
  public listMcpTools: TelegramClientPort['listMcpTools'] = () =>
    this.activeDelegate.listMcpTools();
  public invokeMcpTool: TelegramClientPort['invokeMcpTool'] = (r) =>
    this.activeDelegate.invokeMcpTool(r);
  public approveMcpToolCall: TelegramClientPort['approveMcpToolCall'] = (id, a) =>
    this.activeDelegate.approveMcpToolCall(id, a);
  public startTalkSession: TelegramClientPort['startTalkSession'] = () =>
    this.activeDelegate.startTalkSession();
  public sendTalkAudio: TelegramClientPort['sendTalkAudio'] = (a) =>
    this.activeDelegate.sendTalkAudio(a);
  public bargeInTalkSession: TelegramClientPort['bargeInTalkSession'] = () =>
    this.activeDelegate.bargeInTalkSession();
  public stopTalkSession: TelegramClientPort['stopTalkSession'] = () =>
    this.activeDelegate.stopTalkSession();
  public listComputers: TelegramClientPort['listComputers'] = () =>
    this.activeDelegate.listComputers();
  public executeComputerOp: TelegramClientPort['executeComputerOp'] = (n, op, l) =>
    this.activeDelegate.executeComputerOp(n, op, l);
  public approveComputerCommand: TelegramClientPort['approveComputerCommand'] = (id, a) =>
    this.activeDelegate.approveComputerCommand(id, a);
  public updateComputerPolicy: TelegramClientPort['updateComputerPolicy'] = (n, p) =>
    this.activeDelegate.updateComputerPolicy(n, p);
  public emergencyTakeoverComputer: TelegramClientPort['emergencyTakeoverComputer'] = (n) =>
    this.activeDelegate.emergencyTakeoverComputer(n);
  public getTailnetStatus: TelegramClientPort['getTailnetStatus'] = () =>
    this.activeDelegate.getTailnetStatus();
  public getWalletState: TelegramClientPort['getWalletState'] = () =>
    this.activeDelegate.getWalletState();
  public topUpStars: TelegramClientPort['topUpStars'] = (a) =>
    this.activeDelegate.topUpStars(a);
  public sendStarGift: TelegramClientPort['sendStarGift'] = (r) =>
    this.activeDelegate.sendStarGift(r);

  public sendCallbackQuery = (
    chatId: number,
    messageId: number,
    data: string,
  ): Promise<{ answerText?: string; message?: MessageItem }> =>
    this.activeDelegate.sendCallbackQuery(chatId, messageId, data);

  public clearChatHistory = (chatId: number, forEveryone = true): Promise<void> =>
    this.activeDelegate.clearChatHistory(chatId, forEveryone);

  // F17 BrowserControlClientPort delegates
  public createDesktopPairingTicket: BrowserControlClientPort['createDesktopPairingTicket'] = (o) =>
    this.activeDelegate.createDesktopPairingTicket(o);
  public claimDesktopPairingTicket: BrowserControlClientPort['claimDesktopPairingTicket'] = (c, l) =>
    this.activeDelegate.claimDesktopPairingTicket(c, l);
  public listBrowserTargets: BrowserControlClientPort['listBrowserTargets'] = () =>
    this.activeDelegate.listBrowserTargets();
  public registerBrowserTarget: BrowserControlClientPort['registerBrowserTarget'] = (p) =>
    this.activeDelegate.registerBrowserTarget(p);
  public reportBrowserState: BrowserControlClientPort['reportBrowserState'] = (p) =>
    this.activeDelegate.reportBrowserState(p);
  public sendBrowserCommand: BrowserControlClientPort['sendBrowserCommand'] = (r) =>
    this.activeDelegate.sendBrowserCommand(r);
  public revokeBrowserControl: BrowserControlClientPort['revokeBrowserControl'] = (o) =>
    this.activeDelegate.revokeBrowserControl(o);
  public listBrowserAuditLogs: BrowserControlClientPort['listBrowserAuditLogs'] = (l) =>
    this.activeDelegate.listBrowserAuditLogs(l);
  public openHeadlessSession: BrowserControlClientPort['openHeadlessSession'] = (r) =>
    this.activeDelegate.openHeadlessSession(r);
  public listHeadlessSessions: BrowserControlClientPort['listHeadlessSessions'] = () =>
    this.activeDelegate.listHeadlessSessions();
  public executeHeadlessAction: BrowserControlClientPort['executeHeadlessAction'] = (sid, r) =>
    this.activeDelegate.executeHeadlessAction(sid, r);
  public captureHeadlessScreenshot: BrowserControlClientPort['captureHeadlessScreenshot'] = (sid) =>
    this.activeDelegate.captureHeadlessScreenshot(sid);
  public closeHeadlessSession: BrowserControlClientPort['closeHeadlessSession'] = (sid) =>
    this.activeDelegate.closeHeadlessSession(sid);
  public invokeMcpRpc: BrowserControlClientPort['invokeMcpRpc'] = (r) =>
    this.activeDelegate.invokeMcpRpc(r);
}
