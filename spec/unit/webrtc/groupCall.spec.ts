/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { EventType, GroupCallIntent, GroupCallType, MatrixCall, MatrixEvent, Room, RoomMember } from '../../../src';
import { GroupCall } from "../../../src/webrtc/groupCall";
import { MatrixClient } from "../../../src/client";
import {
    installWebRTCMocks,
    MockMediaHandler,
    MockMediaStream,
    MockMediaStreamTrack,
    MockRTCPeerConnection,
} from '../../test-utils/webrtc';
import { SDPStreamMetadataKey, SDPStreamMetadataPurpose } from "../../../src/webrtc/callEventTypes";
import { sleep } from "../../../src/utils";
import { ReEmitter } from "../../../src/ReEmitter";
import { TypedEventEmitter } from '../../../src/models/typed-event-emitter';
import { MediaHandler } from '../../../src/webrtc/mediaHandler';
import { CallEventHandlerEvent, CallEventHandlerEventHandlerMap } from '../../../src/webrtc/callEventHandler';
import { CallFeed } from '../../../src/webrtc/callFeed';
import { CallState } from '../../../src/webrtc/call';

const FAKE_ROOM_ID = "!fake:test.dummy";
const FAKE_CONF_ID = "fakegroupcallid";

const FAKE_USER_ID_1 = "@alice:test.dummy";
const FAKE_DEVICE_ID_1 = "@AAAAAA";
const FAKE_SESSION_ID_1 = "alice1";
const FAKE_USER_ID_2 = "@bob:test.dummy";
const FAKE_DEVICE_ID_2 = "@BBBBBB";
const FAKE_SESSION_ID_2 = "bob1";
const FAKE_STATE_EVENTS = [
    {
        getContent: () => ({
            ["m.expires_ts"]: Date.now() + ONE_HOUR,
        }),
        getStateKey: () => FAKE_USER_ID_1,
        getRoomId: () => FAKE_ROOM_ID,
    },
    {
        getContent: () => ({
            ["m.expires_ts"]: Date.now() + ONE_HOUR,
            ["m.calls"]: [{
                ["m.call_id"]: FAKE_CONF_ID,
                ["m.devices"]: [{
                    device_id: FAKE_DEVICE_ID_2,
                    feeds: [],
                }],
            }],
        }),
        getStateKey: () => FAKE_USER_ID_2,
        getRoomId: () => FAKE_ROOM_ID,
    }, {
        getContent: () => ({
            ["m.expires_ts"]: Date.now() + ONE_HOUR,
            ["m.calls"]: [{
                ["m.call_id"]: FAKE_CONF_ID,
                ["m.devices"]: [{
                    device_id: "user3_device",
                    feeds: [],
                }],
            }],
        }),
        getStateKey: () => "user3",
        getRoomId: () => FAKE_ROOM_ID,
    },
];

const ONE_HOUR = 1000 * 60 * 60;

const createAndEnterGroupCall = async (cli: MatrixClient, room: Room): Promise<GroupCall> => {
    const groupCall = new GroupCall(
        cli,
        room,
        GroupCallType.Video,
        false,
        GroupCallIntent.Prompt,
        FAKE_CONF_ID,
    );

    await groupCall.create();
    await groupCall.enter();

    return groupCall;
};

class MockCallMatrixClient extends TypedEventEmitter<CallEventHandlerEvent.Incoming, CallEventHandlerEventHandlerMap> {
    public mediaHandler: MediaHandler = new MockMediaHandler() as unknown as MediaHandler;

    constructor(public userId: string, public deviceId: string, public sessionId: string) {
        super();
    }

    groupCallEventHandler = {
        groupCalls: new Map(),
    };

    callEventHandler = {
        calls: new Map(),
    };

    sendStateEvent = jest.fn();
    sendToDevice = jest.fn();

    getMediaHandler() { return this.mediaHandler; }

    getUserId() { return this.userId; }

    getDeviceId() { return this.deviceId; }
    getSessionId() { return this.sessionId; }

    getTurnServers = () => [];
    isFallbackICEServerAllowed = () => false;
    reEmitter = new ReEmitter(new TypedEventEmitter());
    getUseE2eForGroupCall = () => false;
    checkTurnServers = () => null;
}

class MockCall {
    constructor(public roomId: string, public groupCallId: string) {
    }

    public state = CallState.Ringing;
    public opponentUserId = FAKE_USER_ID_1;
    public callId = "1";

    public reject = jest.fn<void, []>();
    public answerWithCallFeeds = jest.fn<void, [CallFeed[]]>();
    public hangup = jest.fn<void, []>();

    on = jest.fn();
    removeListener = jest.fn();

    getOpponentMember() {
        return {
            userId: this.opponentUserId,
        };
    }
}

describe('Group Call', function() {
    beforeEach(function() {
        installWebRTCMocks();
    });

    describe('Basic functionality', function() {
        let mockSendState: jest.Mock;
        let mockClient: MatrixClient;
        let room: Room;
        let groupCall: GroupCall;

        beforeEach(function() {
            const typedMockClient = new MockCallMatrixClient(
                FAKE_USER_ID_1, FAKE_DEVICE_ID_1, FAKE_SESSION_ID_1,
            );
            mockSendState = typedMockClient.sendStateEvent;

            mockClient = typedMockClient as unknown as MatrixClient;

            room = new Room(FAKE_ROOM_ID, mockClient, FAKE_USER_ID_1);
            groupCall = new GroupCall(mockClient, room, GroupCallType.Video, false, GroupCallIntent.Prompt);
        });

        it("sends state event to room when creating", async () => {
            await groupCall.create();

            expect(mockSendState).toHaveBeenCalledWith(
                FAKE_ROOM_ID, EventType.GroupCallPrefix, expect.objectContaining({
                    "m.type": GroupCallType.Video,
                    "m.intent": GroupCallIntent.Prompt,
                }),
                groupCall.groupCallId,
            );
        });

        it("sends member state event to room on enter", async () => {
            room.currentState.members[FAKE_USER_ID_1] = {
                userId: FAKE_USER_ID_1,
            } as unknown as RoomMember;

            await groupCall.create();

            try {
                await groupCall.enter();

                expect(mockSendState).toHaveBeenCalledWith(
                    FAKE_ROOM_ID,
                    EventType.GroupCallMemberPrefix,
                    expect.objectContaining({
                        "m.calls": [
                            expect.objectContaining({
                                "m.call_id": groupCall.groupCallId,
                                "m.devices": [
                                    expect.objectContaining({
                                        device_id: FAKE_DEVICE_ID_1,
                                    }),
                                ],
                            }),
                        ],
                    }),
                    FAKE_USER_ID_1,
                );
            } finally {
                groupCall.leave();
            }
        });

        it("starts with mic unmuted in regular calls", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                expect(groupCall.isMicrophoneMuted()).toEqual(false);
            } finally {
                groupCall.leave();
            }
        });

        it("starts with mic muted in PTT calls", async () => {
            try {
                // replace groupcall with a PTT one for this test
                // we will probably want a dedicated test suite for PTT calls, so when we do,
                // this can go in there instead.
                groupCall = new GroupCall(mockClient, room, GroupCallType.Video, true, GroupCallIntent.Prompt);

                await groupCall.create();

                await groupCall.initLocalCallFeed();

                expect(groupCall.isMicrophoneMuted()).toEqual(true);
            } finally {
                groupCall.leave();
            }
        });

        it("disables audio stream when audio is set to muted", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                await groupCall.setMicrophoneMuted(true);

                expect(groupCall.isMicrophoneMuted()).toEqual(true);
            } finally {
                groupCall.leave();
            }
        });

        it("starts with video unmuted in regular calls", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                expect(groupCall.isLocalVideoMuted()).toEqual(false);
            } finally {
                groupCall.leave();
            }
        });

        it("disables video stream when video is set to muted", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                await groupCall.setLocalVideoMuted(true);

                expect(groupCall.isLocalVideoMuted()).toEqual(true);
            } finally {
                groupCall.leave();
            }
        });

        it("retains state of local user media stream when updated", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                const oldStream = groupCall.localCallFeed.stream as unknown as MockMediaStream;

                // arbitrary values, important part is that they're the same afterwards
                await groupCall.setLocalVideoMuted(true);
                await groupCall.setMicrophoneMuted(false);

                const newStream = await mockClient.getMediaHandler().getUserMediaStream(true, true);

                groupCall.updateLocalUsermediaStream(newStream);

                expect(groupCall.localCallFeed.stream).toBe(newStream);

                expect(groupCall.isLocalVideoMuted()).toEqual(true);
                expect(groupCall.isMicrophoneMuted()).toEqual(false);

                expect(oldStream.isStopped).toEqual(true);
            } finally {
                groupCall.leave();
            }
        });
    });

    describe('Placing calls', function() {
        let groupCall1: GroupCall;
        let groupCall2: GroupCall;
        let client1: MatrixClient;
        let client2: MatrixClient;

        beforeEach(function() {
            MockRTCPeerConnection.resetInstances();

            client1 = new MockCallMatrixClient(
                FAKE_USER_ID_1, FAKE_DEVICE_ID_1, FAKE_SESSION_ID_1,
            ) as unknown as MatrixClient;

            client2 = new MockCallMatrixClient(
                FAKE_USER_ID_2, FAKE_DEVICE_ID_2, FAKE_SESSION_ID_2,
            ) as unknown as MatrixClient;

            client1.sendStateEvent = client2.sendStateEvent = (roomId, eventType, content, statekey) => {
                if (eventType === EventType.GroupCallMemberPrefix) {
                    const fakeEvent = {
                        getContent: () => content,
                        getRoomId: () => FAKE_ROOM_ID,
                        getStateKey: () => statekey,
                    } as unknown as MatrixEvent;

                    let subMap = client1Room.currentState.events.get(eventType);
                    if (!subMap) {
                        subMap = new Map<string, MatrixEvent>();
                        client1Room.currentState.events.set(eventType, subMap);
                        client2Room.currentState.events.set(eventType, subMap);
                    }
                    // since we cheat & use the same maps for each, we can
                    // just add it once.
                    subMap.set(statekey, fakeEvent);

                    groupCall1.onMemberStateChanged(fakeEvent);
                    groupCall2.onMemberStateChanged(fakeEvent);
                }
                return Promise.resolve(null);
            };

            const client1Room = new Room(FAKE_ROOM_ID, client1, FAKE_USER_ID_1);

            const client2Room = new Room(FAKE_ROOM_ID, client2, FAKE_USER_ID_2);

            groupCall1 = new GroupCall(
                client1, client1Room, GroupCallType.Video, false, GroupCallIntent.Prompt, FAKE_CONF_ID,
            );

            groupCall2 = new GroupCall(
                client2, client2Room, GroupCallType.Video, false, GroupCallIntent.Prompt, FAKE_CONF_ID,
            );

            client1Room.currentState.members[FAKE_USER_ID_1] = {
                userId: FAKE_USER_ID_1,
            } as unknown as RoomMember;
            client1Room.currentState.members[FAKE_USER_ID_2] = {
                userId: FAKE_USER_ID_2,
            } as unknown as RoomMember;

            client2Room.currentState.members[FAKE_USER_ID_1] = {
                userId: FAKE_USER_ID_1,
            } as unknown as RoomMember;
            client2Room.currentState.members[FAKE_USER_ID_2] = {
                userId: FAKE_USER_ID_2,
            } as unknown as RoomMember;
        });

        afterEach(function() {
            MockRTCPeerConnection.resetInstances();
        });

        it("Places a call to a peer", async function() {
            await groupCall1.create();

            try {
                // keep this as its own variable so we have it typed as a mock
                // rather than its type in the client object
                const mockSendToDevice = jest.fn<Promise<{}>, [
                    eventType: string,
                    contentMap: { [userId: string]: { [deviceId: string]: Record<string, any> } },
                    txnId?: string,
                ]>();

                const toDeviceProm = new Promise<void>(resolve => {
                    mockSendToDevice.mockImplementation(() => {
                        resolve();
                        return Promise.resolve({});
                    });
                });

                client1.sendToDevice = mockSendToDevice;

                await Promise.all([groupCall1.enter(), groupCall2.enter()]);

                MockRTCPeerConnection.triggerAllNegotiations();

                await toDeviceProm;

                expect(mockSendToDevice.mock.calls[0][0]).toBe("m.call.invite");

                const toDeviceCallContent = mockSendToDevice.mock.calls[0][1];
                expect(Object.keys(toDeviceCallContent).length).toBe(1);
                expect(Object.keys(toDeviceCallContent)[0]).toBe(FAKE_USER_ID_2);

                const toDeviceBobDevices = toDeviceCallContent[FAKE_USER_ID_2];
                expect(Object.keys(toDeviceBobDevices).length).toBe(1);
                expect(Object.keys(toDeviceBobDevices)[0]).toBe(FAKE_DEVICE_ID_2);

                const bobDeviceMessage = toDeviceBobDevices[FAKE_DEVICE_ID_2];
                expect(bobDeviceMessage.conf_id).toBe(FAKE_CONF_ID);
            } finally {
                await Promise.all([groupCall1.leave(), groupCall2.leave()]);
            }
        });
    });

    describe("muting", () => {
        let mockClient: MatrixClient;
        let room: Room;

        beforeEach(() => {
            const typedMockClient = new MockCallMatrixClient(
                FAKE_USER_ID_1, FAKE_DEVICE_ID_1, FAKE_SESSION_ID_1,
            );
            mockClient = typedMockClient as unknown as MatrixClient;

            room = new Room(FAKE_ROOM_ID, mockClient, FAKE_USER_ID_1);
            room.currentState.getStateEvents = jest.fn().mockImplementation((type: EventType, userId: string) => {
                return type === EventType.GroupCallMemberPrefix
                    ? FAKE_STATE_EVENTS.find(e => e.getStateKey() === userId) || FAKE_STATE_EVENTS
                    : { getContent: () => ([]) };
            });
            room.getMember = jest.fn().mockImplementation((userId) => ({ userId }));
        });

        describe("local muting", () => {
            it("should mute local audio when calling setMicrophoneMuted()", async () => {
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                groupCall.localCallFeed.setAudioVideoMuted = jest.fn();
                const setAVMutedArray = groupCall.calls.map(call => {
                    call.localUsermediaFeed.setAudioVideoMuted = jest.fn();
                    return call.localUsermediaFeed.setAudioVideoMuted;
                });
                const tracksArray = groupCall.calls.reduce((acc, call) => {
                    acc.push(...call.localUsermediaStream.getAudioTracks());
                    return acc;
                }, []);
                const sendMetadataUpdateArray = groupCall.calls.map(call => {
                    call.sendMetadataUpdate = jest.fn();
                    return call.sendMetadataUpdate;
                });

                await groupCall.setMicrophoneMuted(true);

                groupCall.localCallFeed.stream.getAudioTracks().forEach(track => expect(track.enabled).toBe(false));
                expect(groupCall.localCallFeed.setAudioVideoMuted).toHaveBeenCalledWith(true, null);
                setAVMutedArray.forEach(f => expect(f).toHaveBeenCalledWith(true, null));
                tracksArray.forEach(track => expect(track.enabled).toBe(false));
                sendMetadataUpdateArray.forEach(f => expect(f).toHaveBeenCalled());

                groupCall.terminate();
            });

            it("should mute local video when calling setLocalVideoMuted()", async () => {
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                groupCall.localCallFeed.setAudioVideoMuted = jest.fn();
                const setAVMutedArray = groupCall.calls.map(call => {
                    call.localUsermediaFeed.setAudioVideoMuted = jest.fn();
                    return call.localUsermediaFeed.setAudioVideoMuted;
                });
                const tracksArray = groupCall.calls.reduce((acc, call) => {
                    acc.push(...call.localUsermediaStream.getVideoTracks());
                    return acc;
                }, []);
                const sendMetadataUpdateArray = groupCall.calls.map(call => {
                    call.sendMetadataUpdate = jest.fn();
                    return call.sendMetadataUpdate;
                });

                await groupCall.setLocalVideoMuted(true);

                groupCall.localCallFeed.stream.getVideoTracks().forEach(track => expect(track.enabled).toBe(false));
                expect(groupCall.localCallFeed.setAudioVideoMuted).toHaveBeenCalledWith(null, true);
                setAVMutedArray.forEach(f => expect(f).toHaveBeenCalledWith(null, true));
                tracksArray.forEach(track => expect(track.enabled).toBe(false));
                sendMetadataUpdateArray.forEach(f => expect(f).toHaveBeenCalled());

                groupCall.terminate();
            });
        });

        describe("remote muting", () => {
            const getMetadataEvent = (audio: boolean, video: boolean): MatrixEvent => ({
                getContent: () => ({
                    [SDPStreamMetadataKey]: {
                        stream: {
                            purpose: SDPStreamMetadataPurpose.Usermedia,
                            audio_muted: audio,
                            video_muted: video,
                        },
                    },
                }),
            } as MatrixEvent);

            it("should mute remote feed's audio after receiving metadata with video audio", async () => {
                const metadataEvent = getMetadataEvent(true, false);
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                // It takes a bit of time for the calls to get created
                await sleep(10);

                const call = groupCall.calls[0];
                call.getOpponentMember = () => ({ userId: call.invitee }) as RoomMember;
                // @ts-ignore Mock
                call.pushRemoteFeed(new MockMediaStream("stream", [
                    new MockMediaStreamTrack("audio_track", "audio"),
                    new MockMediaStreamTrack("video_track", "video"),
                ]));
                call.onSDPStreamMetadataChangedReceived(metadataEvent);

                const feed = groupCall.getUserMediaFeedByUserId(call.invitee);
                expect(feed.isAudioMuted()).toBe(true);
                expect(feed.isVideoMuted()).toBe(false);

                groupCall.terminate();
            });

            it("should mute remote feed's video after receiving metadata with video muted", async () => {
                const metadataEvent = getMetadataEvent(false, true);
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                // It takes a bit of time for the calls to get created
                await sleep(10);

                const call = groupCall.calls[0];
                call.getOpponentMember = () => ({ userId: call.invitee }) as RoomMember;
                // @ts-ignore Mock
                call.pushRemoteFeed(new MockMediaStream("stream", [
                    new MockMediaStreamTrack("audio_track", "audio"),
                    new MockMediaStreamTrack("video_track", "video"),
                ]));
                call.onSDPStreamMetadataChangedReceived(metadataEvent);

                const feed = groupCall.getUserMediaFeedByUserId(call.invitee);
                expect(feed.isAudioMuted()).toBe(false);
                expect(feed.isVideoMuted()).toBe(true);

                groupCall.terminate();
            });
        });
    });

    describe("incoming calls", () => {
        let mockClient: MatrixClient;
        let room: Room;
        let groupCall: GroupCall;

        beforeEach(async () => {
            // we are bob here because we're testing incoming calls, and since alice's user id
            // is lexicographically before Bob's, the spec requires that she calls Bob.
            const typedMockClient = new MockCallMatrixClient(
                FAKE_USER_ID_2, FAKE_DEVICE_ID_2, FAKE_SESSION_ID_2,
            );
            mockClient = typedMockClient as unknown as MatrixClient;

            room = new Room(FAKE_ROOM_ID, mockClient, FAKE_USER_ID_2);
            room.getMember = jest.fn().mockImplementation((userId) => ({ userId }));

            groupCall = await createAndEnterGroupCall(mockClient, room);
        });

        afterEach(() => {
            groupCall.leave();
        });

        it("ignores incoming calls for other rooms", async () => {
            const mockCall = new MockCall("!someotherroom.fake.dummy", groupCall.groupCallId);

            mockClient.emit(CallEventHandlerEvent.Incoming, mockCall as unknown as MatrixCall);

            expect(mockCall.reject).not.toHaveBeenCalled();
            expect(mockCall.answerWithCallFeeds).not.toHaveBeenCalled();
        });

        it("rejects incoming calls for the wrong group call", async () => {
            const mockCall = new MockCall(room.roomId, "not " + groupCall.groupCallId);

            mockClient.emit(CallEventHandlerEvent.Incoming, mockCall as unknown as MatrixCall);

            expect(mockCall.reject).toHaveBeenCalled();
        });

        it("ignores incoming calls not in the ringing state", async () => {
            const mockCall = new MockCall(room.roomId, groupCall.groupCallId);
            mockCall.state = CallState.Connected;

            mockClient.emit(CallEventHandlerEvent.Incoming, mockCall as unknown as MatrixCall);

            expect(mockCall.reject).not.toHaveBeenCalled();
            expect(mockCall.answerWithCallFeeds).not.toHaveBeenCalled();
        });

        it("answers calls for the right room & group call ID", async () => {
            const mockCall = new MockCall(room.roomId, groupCall.groupCallId);

            mockClient.emit(CallEventHandlerEvent.Incoming, mockCall as unknown as MatrixCall);

            expect(mockCall.reject).not.toHaveBeenCalled();
            expect(mockCall.answerWithCallFeeds).toHaveBeenCalled();
            expect(groupCall.calls).toEqual([mockCall]);
        });

        it("replaces calls if it already has one with the same user", async () => {
            const oldMockCall = new MockCall(room.roomId, groupCall.groupCallId);
            const newMockCall = new MockCall(room.roomId, groupCall.groupCallId);
            newMockCall.callId = "not " + oldMockCall.callId;

            mockClient.emit(CallEventHandlerEvent.Incoming, oldMockCall as unknown as MatrixCall);
            mockClient.emit(CallEventHandlerEvent.Incoming, newMockCall as unknown as MatrixCall);

            expect(oldMockCall.hangup).toHaveBeenCalled();
            expect(newMockCall.answerWithCallFeeds).toHaveBeenCalled();
            expect(groupCall.calls).toEqual([newMockCall]);
        });
    });
});
