/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/* eslint-disable no-unused-vars */
/* eslint-disable no-console */

/* 
 * Sample Telephony Vendor SDK 
 * @author dlouvton
 */

 /** @module vendor-sdk **/
 import { publishEvent, log, ActiveCallsResult, AgentConfigResult, CapabilitiesResult, RecordingToggleResult, ParticipantResult, MuteToggleResult,
    PhoneContactsResult, CallResult, HangupResult, HoldToggleResult, InitResult, GenericResult, SignedRecordingUrlResult,
    LogoutResult, CallInfo, PhoneCall, PhoneCallAttributes, Contact, Constants, Phone, StatsInfo, AudioStats, AgentStatusInfo, AudioStatsElement, SuperviseCallResult, SupervisorHangupResult, SupervisedCallInfo } from '@salesforce/scv-connector-base';
import { io } from "socket.io-client";
import { USER_MESSAGE, FILTER_TYPES_TO_CONTACT_TYPES } from '../common/constants';

/** 
 * Class representing a Phone Call
 */
class Call extends PhoneCall {
     /**
     * Create a Call.
     * @param {string} callType - Outbound, Inbound or Transfer
     * @param {Contact} contact - Contact associated with this Call
     * @param {string} callAttributes - call attributes 
     * @param {string} callInfo - call info 
     */
    constructor(callType, contact, callAttributes, callInfo, callId) {
        const state = Constants.CALL_STATE.RINGING;
        callAttributes.initialCallHasEnded = false;
        callAttributes.state = state;
        callAttributes.isOnHold = callInfo && callInfo.isOnHold;
        callId = callId || Math.random().toString(36).substring(7);
        if (callAttributes.participantType === Constants.PARTICIPANT_TYPE.INITIAL_CALLER) {
            callInfo.parentCallId = callId;
        }
        super({ callId, callType, contact, state, callAttributes, phoneNumber: contact && contact.phoneNumber, callInfo }); 
    }

    /**
     * set callId of parent call
     */
    set parentCallId(parentCallId) {
        this.callInfo.parentCallId = parentCallId;
    }
}

/** 
 * Class representing a Softphone SDK
 */
export class Sdk {
    /**
     * Create a Softphone SDK instance.
     * @param {object} state - SDK state
     */
    constructor(state = { 
        isLoginRequired: true, 
        agentConfig: JSON.parse(localStorage.getItem('agentConfig')) || {
            phones : [ "SOFT_PHONE", "DESK_PHONE"],
            selectedPhone : {type:"SOFT_PHONE"}
        },
        capabilities: JSON.parse(localStorage.getItem('capabilities')) || {
            hasMute: true,
            hasRecord: true,
            hasMerge: true,
            hasSwap: true,
            hasSignedRecordingUrl: false,
            debugEnabled: true,
            signedRecordingUrl: '',
            signedRecordingDuration: null,
            hasContactSearch: true,
            hasAgentAvailability: true,
            hasQueueWaitTime: false,
            supportsMos : true,
            hasSupervisorListenIn: false,
            hasSupervisorBargeIn: false,
            hasBlindTransfer : false,
            hasTransferToOmniFlow : true
        },
        agentId: null,
        userFullName: null,
        activeCalls: this.getActiveCallsObj(),
        destroyedCalls: [],
        agentStatus: "Available",
        publishHardphoneErrors: true,
        agentAvailable: false,
        phoneContacts: this.getAllPhoneContacts(20),
        onlineUsers: [],
        userPresenceStatuses: null,
        delayMs: 0, //Delay in milliseconds before resolving a promise
        updateRemoveTransferCallParticipantVariant: Constants.REMOVE_PARTICIPANT_VARIANT.ALWAYS,
        contactTypes: JSON.parse(localStorage.getItem('contactTypes')) || 
            [ Constants.CONTACT_TYPE.AGENT, Constants.CONTACT_TYPE.QUEUE, Constants.CONTACT_TYPE.PHONEBOOK, Constants.CONTACT_TYPE.PHONENUMBER ]
    }){
        this.state = {...state, 
            showLoginPage: !!JSON.parse(localStorage.getItem('showLoginPage')),
            throwError: !!JSON.parse(localStorage.getItem('throwError'))
        };
    }
    /**
     * Get a call from the active calls stored on localStorage)
     */
    getCall(call) {
        if (!call || !this.hasActiveCalls()){
            throw new Error("Couldn't find an active call", call);
        }
        if (call.callAttributes && call.callAttributes.participantType) {
            const callByParticipant = Object.values(this.state.activeCalls).filter((obj) => obj['callAttributes']['participantType'] === call.callAttributes.participantType).pop();
            if (!callByParticipant) {
                throw new Error("Couldn't find an active call for participant " + call.callAttributes.participantType);
            }
            return callByParticipant;
        }
        if (call.callId) {
            const callByCallId = this.state.activeCalls[call.callId];
            if (!callByCallId) {
                throw new Error("Couldn't find an active call for callId " + call.callId);
            }
            return callByCallId;
        } 
        throw new Error("Call is not valid. It must have callAttributes and/or callId.", call);
    }
    /**
     * Add a call to the active calls (persisted on localStorage)
     */
    addCall(call) {
        this.state.activeCalls[call.callId] = call;
        localStorage.setItem('activeCalls', JSON.stringify(this.state.activeCalls));
    }

    /**
     * Message a user (via websocket)
     * if toUsername is null, the message is broadcasted to all users
     */
    messageUser(toUsername, messageType, data){
        const socket = io();
        const fromUsername = this.state.agentId;
        socket.emit("message", { fromUsername, toUsername, messageType, data });
    }
    /**
     * Notify users about your presence (via websocket)
     */
    toggleAgentPresence(isAvailable){
        const socket = io();
        const username = this.state.agentId;
        socket.emit("presence", { isAvailable, username });
    }
    /**
     * Update the Main Call Info (with the initial caller or supervisor)
     */
    updateInitialCallInfo(value) {
        let call;
        try {
            call = this.getCall({ callAttributes: { participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER }});
        } catch(e) {
            call = this.getCall({ callAttributes: { participantType: Constants.PARTICIPANT_TYPE.SUPERVISOR }});
        }
        Object.assign(call.callInfo, value);
        this.addCall(call);
    }

    /*
    * This method is for demo purposes. Enables/disables the show login page for testing
    */
    showLoginPage(enable) {
        localStorage.setItem('showLoginPage', enable);
        this.state.showLoginPage = enable;
    }

    setAgentConfig(config) {
        this.state.agentConfig.selectedPhone = config.selectedPhone;
        localStorage.setItem('agentConfig', JSON.stringify(this.state.agentConfig));
        return this.executeAsync("setAgentConfig", new GenericResult({
            success: true
        }));
    }

    /*
    * Update Agent Config used only for Voice call simulator
    */
   updateAgentConfig(agentConfig) {
       this.state.agentConfig.selectedPhone = agentConfig.selectedPhone;
       localStorage.setItem('agentConfig', JSON.stringify(this.state.agentConfig));
    }

    setCapabilities() {
        localStorage.setItem('capabilities', JSON.stringify(this.state.capabilities));
        return this.executeAsync("setCapabilities", new GenericResult({ success: true }));
    }

    /*
    * Update Capabilities used only for Voice call simulator
    */
   updateCapabilities(capabilities) {
    this.state.capabilities.hasSignedRecordingUrl = capabilities.hasSignedRecordingUrl;
    this.state.capabilities.signedRecordingUrl = capabilities.signedRecordingUrl;
    this.state.capabilities.signedRecordingDuration = capabilities.signedRecordingDuration;
    this.state.capabilities.hasMute = capabilities.hasMute;
    this.state.capabilities.hasRecord = capabilities.hasRecord;
    this.state.capabilities.hasSwap = capabilities.hasSwap;
    this.state.capabilities.hasMerge = capabilities.hasMerge;
    this.state.capabilities.hasContactSearch = capabilities.hasContactSearch;
    this.state.capabilities.supportsMos = capabilities.supportsMos;
    this.state.capabilities.hasAgentAvailability = capabilities.hasAgentAvailability;
    this.state.capabilities.hasQueueWaitTime = capabilities.hasQueueWaitTime;
    this.state.capabilities.hasSupervisorListenIn = capabilities.hasSupervisorListenIn;
    this.state.capabilities.hasSupervisorBargeIn = capabilities.hasSupervisorBargeIn;
    this.state.capabilities.hasBlindTransfer = capabilities.hasBlindTransfer;
    this.state.capabilities.hasTransferToOmniFlow = capabilities.hasTransferToOmniFlow;
    this.state.capabilities.debugEnabled = capabilities.debugEnabled;
    localStorage.setItem('capabilities', JSON.stringify(this.state.capabilities));
 }

    /*
    * Update contact types for add participant for voice call simulator
    */
   updateContactTypes(contactTypes) {
       this.state.contactTypes = contactTypes;
       localStorage.setItem('contactTypes', JSON.stringify(this.state.contactTypes));
   }

    /*
    * This method is for demo purposes. Enables/disables throwing sdk errors for testing
    */
   throwError(enable) {
        localStorage.setItem('throwError', enable);
        this.state.throwError = enable;
    }

    /*
    * This method simulates the vendor sending a login result
    */
    subsystemLoginResult(success) {
        this.state.agentAvailable = success;
        publishEvent({ eventType: Constants.EVENT_TYPE.LOGIN_RESULT, payload: new GenericResult({
            success: (this.state.showLoginPage && success)
        })});
    }

    /**
     * log a message
     */
    log(...args) {
        if(this.state.capabilities.debugEnabled) {
            const message = args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
            log({ message }, Constants.LOG_LEVEL.INFO);
            return;
        }
        Function.apply.call(console.log, console, ["[sdk]", ...args]);
    }

    /** 
        filter contacts - simulating backend search
    */
    filterContacts(contacts, filter) {
        if (!filter) {
            return contacts;
        }
        let result = contacts;
        if (filter.contains) {
            result = result.filter(obj => Object.keys(obj).some(key => obj[key] && obj[key].toLowerCase().includes(filter.contains.toLowerCase())));
        }
        (filter.types || []).forEach(type => {
            const value = FILTER_TYPES_TO_CONTACT_TYPES[type] || type;
            const key = FILTER_TYPES_TO_CONTACT_TYPES[type] ? "type" : "availability";
            result = result.filter(obj =>  obj[key] === value);
        });
        const startIndex = filter.offset ? filter.offset : 0; 
        const endIndex = filter.limit ? startIndex + filter.limit : result.length;
        return result.slice(startIndex, endIndex);  
    }
    /**
     * destroy one or more calls
     * @param {string} reason - reason
     */
    destroyCalls(call, reason) {
        let callsToDestroy = [];
        if (call.callAttributes && call.callAttributes.participantType === Constants.PARTICIPANT_TYPE.AGENT) {
            try {
                const customerCall = this.getCall({ callAttributes: { participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER }});
                callsToDestroy.push(customerCall);
            } catch(e) {
                //noop
            }
            try {
                const thirdPartyCall = this.getCall({ callAttributes: { participantType: Constants.PARTICIPANT_TYPE.THIRD_PARTY }});
                callsToDestroy.push(thirdPartyCall);
            } catch(e) {
                //noop
            }
        } else {
            callsToDestroy.push(this.getCall(call));
        }
        callsToDestroy.forEach((callToDestroy) => {
            const state = Constants.CALL_STATE.ENDED;
            callToDestroy.state = callToDestroy.callAttributes.state = state;
            callToDestroy.reason = reason;
            this.state.destroyedCalls.push(callToDestroy);
            delete this.state.activeCalls[callToDestroy.callId];
        })
        localStorage.setItem("activeCalls", JSON.stringify(this.state.activeCalls));
        return callsToDestroy;
    }
    /**
     * destroy specified call
     * @param {string} reason - reason
     */
    destroyCall(call, reason) {
        return this.destroyCalls(call, reason).pop();
    }
    /**
     * perform sso on a container element
     * @param {object} callCenterConfig - Call Center configuration
     */

    init(callCenterConfig) {
        const username = this.state.agentId = callCenterConfig['userName'];
        this.state.userFullName = callCenterConfig['userFullName'];
        this.state.userPresenceStatuses = callCenterConfig['userPresenceStatuses']
        const socket = io();

        socket.on('onlineUsers', onlineUsers => {
            this.state.onlineUsers = onlineUsers;
        });

        socket.on('connect', () => {
            socket.emit('join', { username });
        });

        socket.on('message', message => {
            this.handleSocketMessage(message);
        });

        const tenantInfo = {
            scrtBaseUrl: callCenterConfig['scrtUrl'],
            orgId: callCenterConfig['organizationId'],
            callCenterName: callCenterConfig['/reqGeneralInfo/reqInternalName']
        };

        return fetch('/api/configureTenantInfo', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(tenantInfo)
        }).then(response => response.json())
          .then((data) => {
            if (data.success) {
                this.toggleAgentPresence(true);
                this.state.agentAvailable = !this.state.showLoginPage;
                return this.executeAsync('ssoLogin', this.state.showLoginPage ?
                new InitResult({ showLogin: true, loginFrameHeight: 350 }) :
                new InitResult({}));
            } else {
                return Promise.reject("Failed to configure tentant information");
            }
        });
    }

    /**
     * handle socket message event
     */
    handleSocketMessage(message) {
        switch(message.messageType){
            case USER_MESSAGE.CALL_STARTED:
                this.startTransferCall(message);
                break;
            case USER_MESSAGE.PARTICIPANT_CONNECTED:
                this.connectParticipant(message.data.callInfo);
                break;
            case USER_MESSAGE.CALL_BARGED_IN:
                this.publishCallBargedInEventToAgents(message.data);
                break;
            default:
                this.log("Could not handle message "+message.messageType, message)
        }
    }

    startTransferCall(message){
        const call = new PhoneCall({
            callType: "inbound",
            phoneNumber: message.data.phoneNumber,
            callId: message.data.callId,
            callInfo: new CallInfo({isOnHold:false}),
            callAttributes: new PhoneCallAttributes({participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER, voiceCallId : message.data.voiceCallId })
        });
        this.addCall(call);
        let callResult = new CallResult({call});
        publishEvent({ eventType: Constants.EVENT_TYPE.CALL_STARTED, payload: callResult});
    }

    /**
     * simulate logout from the telephony sub system
     */
    subsystemLogout() {
        publishEvent({ eventType: Constants.EVENT_TYPE.LOGOUT_RESULT, payload: new LogoutResult({
            success: !this.state.throwError,
            loginFrameHeight: 350
        })});
    }

    /**
     * perform logout from Omni
     */
    omniLogout() {
        return this.executeAsync("SubsystemLogout", new LogoutResult({
            success: true,
            loginFrameHeight: 350
        }));
    }
    /**
     * execute an async action and return a promise
     * @param {string} action
     * @param {object} payload
     * @param {number} delay Delay in milliseconds before resolving the promise
     * @return {Promise}
     */
    executeAsync(action, payload) {
        this.log(`Executing action - ${action}`, payload);
        if (this.state.throwError) {
            return Promise.reject('demo error');
        }
        switch (action) {
            case "mute":
            case "unmute":
                if (!this.state.capabilities.hasMute) {
                    return Promise.reject(new Error('Mute is not supported'));
                }
            break;
            case "conference":
                if (!this.state.capabilities.hasMerge) {
                    return Promise.reject(new Error('Conference is not supported'));
                }
            break;
            case "swapCalls":
                if (!this.state.capabilities.hasSwap) {
                    return Promise.reject(new Error('Swap Calls is not supported'));
                }
            break;
            case "pauseRecording":
            case "resumeRecording":
                if (!this.state.capabilities.hasRecord) {
                    return Promise.reject(new Error('Recording is not supported'));
                }
            break;
            case "getSignedRecordingUrl":
                if (!this.state.capabilities.hasSignedRecordingUrl || !this.state.capabilities.signedRecordingUrl) {
                    return Promise.reject(new Error('Signed recording url is not supported'));
                }
            break;
        }

        if (this.state.delayMs === 0) {
            return Promise.resolve(payload)
        }

        return this.delay(this.state.delayMs).then(() => {
            return Promise.resolve(payload)
        });
    }

    delay(t, v) {
        return new Promise(resolve => {
            setTimeout(resolve.bind(null, v), t)
        });
    }

    /**
     * start a call
     * @param {Contact} contact
     * @param {Object} callInfo (callInfo.isSoftphoneCall is false if dialing from a desk phone)
     */
    dial(contact, callInfo, fireCallStarted) {
        if (this.hasActiveCalls(Constants.PARTICIPANT_TYPE.INITIAL_CALLER)) {
            return Promise.reject(new Error(`Agent is not available for an outbound call`));
        }
        callInfo = callInfo || { isOnHold: false };
        callInfo.callStateTimestamp = new Date();
        const callAttributes = { participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER };
        const call = new Call(Constants.CALL_TYPE.OUTBOUND.toLowerCase(), contact, callAttributes, new CallInfo(callInfo));
        this.addCall(call);
        const callResult = new CallResult({
            call
        });
        if (!callInfo.isSoftphoneCall && fireCallStarted) {
            publishEvent({ eventType: Constants.EVENT_TYPE.CALL_STARTED, payload: callResult });
        }
        this.state.agentAvailable = false;
        return this.executeAsync('dial', callResult);
    }
    /**
     * start a call
     * @param {string} phoneNumber - The phone number associcated with this contact
     * @param {string} callInfo
     */
    startInboundCall(phoneNumber, callInfo) {
        callInfo = callInfo || { isOnHold: false };
        callInfo.callStateTimestamp = new Date();
        if (!this.state.agentAvailable) {
            const message = `Agent is not available for a inbound call from phoneNumber - ${phoneNumber}`;
            this.log(message);
            return Promise.reject(new Error(message));
        }
        let callAttributes = { participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER };
        let contact = new Contact({ phoneNumber });
        return this.createVoiceCall(undefined, Constants.CALL_TYPE.INBOUND, phoneNumber).then((data) => {
            callAttributes.voiceCallId = data.voiceCallId;
            const call = new Call(Constants.CALL_TYPE.INBOUND.toLowerCase(), contact, callAttributes, new CallInfo(callInfo), data.vendorCallKey);
            this.addCall(call);
            const callResult = new CallResult({
                call
            });
            publishEvent({ eventType: Constants.EVENT_TYPE.CALL_STARTED, payload: callResult })
            return this.executeAsync('startInboundCall', callResult);
        });
    }

    getAllPhoneContacts(numOfContactsPerType) {
        let contacts = [];
        for (let i=1; i<=numOfContactsPerType; i++) {
            contacts = contacts.concat(new Contact ({
                id: 'id'+i,
                type: Constants.CONTACT_TYPE.AGENT,
                name : ["Agent Name "]+i,
                phoneNumber: "555555444"+i,
                availability: i%2 > 0 ? "AVAILABLE" : "BUSY"
            }))
        }
        for (let i=numOfContactsPerType+1; i<=numOfContactsPerType*2; i++) {
            contacts = contacts.concat(new Contact ({
                id: 'id'+i,
                type: Constants.CONTACT_TYPE.QUEUE,
                name : "Queue Name "+i,
                queue: "Queue"+i,
                queueWaitTime: (Math.random() * 400).toString()
            }))
        }
        for (let i=numOfContactsPerType*2+1; i<=numOfContactsPerType*3; i++) {
            contacts = contacts.concat(new Contact ({
                id: 'id'+i,
                type: Constants.CONTACT_TYPE.PHONEBOOK,
                name : "Phonebook Entry "+i,
                phoneNumber: "55566644"+i
            }))
        }
        for (let i=numOfContactsPerType*3+1; i<=numOfContactsPerType*4; i++) {
            contacts = contacts.concat(new Contact ({
                id: 'id'+i,
                type: Constants.CONTACT_TYPE.PHONENUMBER,
                name : "Phone Number "+i,
                phoneNumber: "5557774"+i
            }))
        }
        for (let i=numOfContactsPerType*4+1; i<=numOfContactsPerType*5; i++) {
            contacts = contacts.concat(new Contact ({
                endpointARN: 'arn'+i,
                type: Constants.CONTACT_TYPE.PHONENUMBER,
                name : ["ARN "]+i,
                phoneNumber: "5555554"+i
            }))
        }
        return contacts;
    }

    getActiveCallsObj() {
        const activeCalls = JSON.parse(localStorage.getItem('activeCalls')) || {};
        Object.keys(activeCalls).forEach(callId => {
            activeCalls[callId].contact = new Contact(activeCalls[callId].contact);
            activeCalls[callId].callInfo.callStateTimestamp = new Date(activeCalls[callId].callInfo.callStateTimestamp);
            activeCalls[callId].callInfo = new CallInfo(activeCalls[callId].callInfo);
            activeCalls[callId].callAttributes = new PhoneCallAttributes(activeCalls[callId].callAttributes);
            activeCalls[callId] = new PhoneCall(activeCalls[callId]);
        });
        return activeCalls;
    }

    hasActiveCalls(participantType) {
        if (!participantType) {
            return this.state.activeCalls && Object.keys(this.state.activeCalls).length > 0;
        }
        return Object.values(this.state.activeCalls).filter((obj) => obj['callAttributes']['participantType'] === participantType).length > 0;
    }

    /**
     * get agent configs, for example phones supported for agent and selected phone
     */
    getAgentConfig() {
        return this.executeAsync("getAgentConfig", new AgentConfigResult({
            phones: this.state.agentConfig.phones,
            selectedPhone: new Phone (this.state.agentConfig.selectedPhone)
        }));
    }

    /**
     * get agent capabilities, for example if mute or recording is supported
     */
    getCapabilities() {
        return this.executeAsync("getCapabilities", new CapabilitiesResult({
            hasMute: this.state.capabilities.hasMute,
            hasMerge: this.state.capabilities.hasMerge,
            hasRecord: this.state.capabilities.hasRecord,
            hasSwap:  this.state.capabilities.hasSwap,
            hasSignedRecordingUrl: this.state.capabilities.hasSignedRecordingUrl,
            hasContactSearch: this.state.capabilities.hasContactSearch,
            supportsMos: this.state.capabilities.supportsMos,
            hasAgentAvailability: this.state.capabilities.hasAgentAvailability,
            hasQueueWaitTime: this.state.capabilities.hasQueueWaitTime,
            hasSupervisorListenIn: this.state.capabilities.hasSupervisorListenIn,
            hasSupervisorBargeIn: this.state.capabilities.hasSupervisorBargeIn,
            debugEnabled: this.state.capabilities.debugEnabled,
            hasBlindTransfer: this.state.capabilities.hasBlindTransfer,
            hasTransferToOmniFlow: this.state.capabilities.hasTransferToOmniFlow,
            signedRecordingUrl: '',
            signedRecordingDuration: null
        }));
    }

     /**
     * get all active calls
     */
    getActiveCalls() {
        const activeCalls = this.getActiveCallsObj();
        const result = Object.values(activeCalls);
        return this.executeAsync('getActiveCalls', new ActiveCallsResult({ activeCalls: result }));
    }

    /**
     * accept the  call
     * @param {PhoneCall} call
     */
    acceptCall(call){
        let callResult = null;
        if (!this.state.throwError) {
            let callToAccept = this.getCall(call);
            const state = callToAccept.callType.toLowerCase() === Constants.CALL_TYPE.CALLBACK.toLowerCase() &&
                callToAccept.state !== Constants.CALL_STATE.CONNECTED ?
                Constants.CALL_STATE.RINGING : Constants.CALL_STATE.CONNECTED;
            callToAccept.state = state;
            callToAccept.callAttributes.state = state;
            this.log("acceptCall", callToAccept);
            this.addCall(callToAccept);
            this.state.agentAvailable = false;
            this.messageUser(null, USER_MESSAGE.PARTICIPANT_CONNECTED, { callInfo: callToAccept.callInfo });
            callResult = new CallResult({ call: callToAccept });
        }
        return this.executeAsync("acceptCall", callResult);
    }

    /**
     * decline call
     * @param {PhoneCall} call
     */
    declineCall(call) {
        this.log("declineCall", call);
        const destroyedCall = this.destroyCall(call, 'declined');
        this.state.agentAvailable = true;
        return this.executeAsync("declineCall", new CallResult({ call: destroyedCall }));
    }
    /**
     * end call
     * @param {PhoneCall} call
     * @param {string} agentErrorStatus
     */
    endCall(call, agentErrorStatus) {
        this.log("endCall", call, agentErrorStatus);
        let destroyedCalls = [];
        if (!this.state.throwError) {
            destroyedCalls = this.destroyCalls(call, Constants.HANGUP_REASON.PHONE_CALL_ENDED);
            this.state.agentAvailable = Object.keys(this.state.activeCalls).length === 0;
            this.beginWrapup(destroyedCalls[0]);
        }
        return this.executeAsync("endCall", new HangupResult({ calls: destroyedCalls }))
    }
    /**
     * Mute
     */
    mute() {
        const isMuted = true;
        this.updateInitialCallInfo({ isMuted });
        return this.executeAsync("mute", new MuteToggleResult({ isMuted }));
    }
    /**
     * Unmute
     */
    unmute() {
        const isMuted = false;
        this.updateInitialCallInfo({ isMuted });
        return this.executeAsync("mute", new MuteToggleResult({ isMuted }));
    }
    /**
     * hold the call
     * @param {PhoneCall} call
     */
    hold(call) {
        this.updateHoldState(call, true);
        return this.executeAsync("hold", new HoldToggleResult({
            isThirdPartyOnHold: this.isOnHold({ callAttributes: { participantType: Constants.PARTICIPANT_TYPE.THIRD_PARTY }}),
            isCustomerOnHold: this.isOnHold({ callAttributes: { participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER }}),
            calls: this.state.activeCalls
        }));
    }

    /**
     * resume the call
     * @param {PhoneCall} call
     */
    resume(call) {
        this.updateHoldState(call, false);
        return this.executeAsync("resume", new HoldToggleResult({
            isThirdPartyOnHold: this.isOnHold({ callAttributes: { participantType: Constants.PARTICIPANT_TYPE.THIRD_PARTY }}),
            isCustomerOnHold: this.isOnHold({ callAttributes: { participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER }}),
            calls: this.state.activeCalls
        }));
    }
    /**
     * pause recording for the call
     * @param {PhoneCall} call
     */
    pauseRecording(call) {
        const isRecordingPaused = true;
        this.updateInitialCallInfo({ isRecordingPaused });
        return this.executeAsync("pauseRecording", new RecordingToggleResult({ isRecordingPaused }));
    }
    /**
     * resume recording for the call
     * @param {PhoneCall} call
     */
    resumeRecording(call) {
        const isRecordingPaused = false;
        this.updateInitialCallInfo({ isRecordingPaused });
        return this.executeAsync("pauseRecording", new RecordingToggleResult({ isRecordingPaused }));
    }
    /**
    * Supervise a call
    * @param {SuperviseCallResult} SuperviseCallResult
    */
    superviseCall(parentCall) {
        if (this.hasActiveCalls()) {
            return Promise.reject(new Error(`Agent is not available to supervise a call`));
        }
        const call = new PhoneCall({
            callType: parentCall.callType,
            contact: new Contact({ phoneNumber: parentCall.callType === Constants.CALL_TYPE.INBOUND ? parentCall.from : parentCall.to }),
            callId: parentCall.callId,
            callInfo: new CallInfo({ initialCallId : parentCall.callId, callStateTimestamp: new Date() }),
            callAttributes: { voiceCallId: parentCall.voiceCallId, participantType: Constants.PARTICIPANT_TYPE.SUPERVISOR },
            state: this.state.agentConfig.selectedPhone.type === Constants.PHONE_TYPE.SOFT_PHONE ? Constants.CALL_STATE.CONNECTED : Constants.CALL_STATE.RINGING
        })
        this.addCall(call);
        return this.executeAsync("superviseCall", new SuperviseCallResult({ call }));
    }
    /**
    * Disconnect from a Supervised call
    * @param {SupervisorHangupResult} SupervisorHangupResult
    */
    supervisorDisconnect(supervisedCall) {
        let calls;
        if (!this.state.throwError) {
            calls = this.destroyCalls({callAttributes: { participantType: Constants.PARTICIPANT_TYPE.SUPERVISOR }});
        }
        return this.executeAsync("supervisorDisconnect", new SupervisorHangupResult({ calls }));
    }

    /**
    * Barge in into a call as a supervisor
    * @param {SuperviseCallResult} SuperviseCallResult
    */
    supervisorBargeIn(supervisedCall) {
        const call = this.getCall({callAttributes: { participantType: Constants.PARTICIPANT_TYPE.SUPERVISOR }});
        call.callAttributes.hasSupervisorBargedIn = supervisedCall.isBargedIn = true;
        supervisedCall.supervisorName = this.state.userFullName;
        this.addCall(call);
        this.messageUser(null, USER_MESSAGE.CALL_BARGED_IN, supervisedCall);
        return this.executeAsync("supervisorBargeIn", new SuperviseCallResult({ call }));
    }

    /**
     * Return true if a call is on hold. If the call does not exist return undefined
     * @param {PhoneCall} call
     * @return true if a call is on hold
     */
    isOnHold(call) {
        try {
            return this.getCall(call).callAttributes.isOnHold;
        } catch(e) {
            return undefined;
        }
    }
    /**
     * @param {PhoneCall} activeCall
     * @param {boolean} onHold
     */
    updateHoldState(activeCall, onHold) {
        const call = this.getCall(activeCall);
        call.callAttributes.isOnHold = onHold;
        call.callInfo.isOnHold = onHold;
        this.addCall(call);
    }
    /**
     * swap calls
     * @param {PhoneCall} call1 first call to be swapped
     * @param {PhoneCall} call2 second call to be swapped
     */
    swapCalls(call1, call2) {
        const activeCall1 = this.getCall(call1);
        const activeCall2 = this.getCall(call2);
        this.updateHoldState(call1, !activeCall1.callAttributes.isOnHold);
        this.updateHoldState(call2, !activeCall2.callAttributes.isOnHold);
        return this.executeAsync("swapCalls", new HoldToggleResult({
            isThirdPartyOnHold: this.isOnHold(call1),
            isCustomerOnHold: this.isOnHold(call2),
            calls: this.state.activeCalls
        }));
    }
    /**
     * join calls
     * @param {PhoneCall[]} calls to be joined
     */
    conference(calls) {
        calls.forEach((call) => {
            this.updateHoldState(call, false);
        });

        return this.executeAsync("conference", new HoldToggleResult({
            isThirdPartyOnHold: false,
            isCustomerOnHold: false
        }));
    }
    /**
     * set agent status
     * @param {string} agentStatus agent status, Constants.AGENT_STATUS.ONLINE or Constants.AGENT_STATUS.OFFLINE
     * @param {AgentStatusInfo} agentStatusInfo object contains statusId, statusApiName and statusName
     * @param {boolean} enqueueNextState true if the state should be enqueued, which will update the agent's status after a call ends
     */
    setAgentStatus(agentStatus, agentStatusInfo, enqueueNextState) {
        this.agentStatus = agentStatus;
        this.toggleAgentPresence(!(agentStatus === Constants.AGENT_STATUS.OFFLINE));
        return this.executeAsync("setAgentStatus", new GenericResult({
            success: true
        }));
    }
    /**
     * send digits to the active call
     * @param {string} digits - digits to be sent (i.e. 123#)
     */
    sendDigits(digits) {
        return this.executeAsync("sendDigits");
    }
    /**
     * Get Agent Phone Book Contacts
     * @param {object} filter object to filter contacts by
     */
    getPhoneContacts(filter) {
        let onlineContacts = [];
        this.state.onlineUsers.forEach((user) => {
            if (this.state.agentId !== user) {
                onlineContacts = onlineContacts.concat(new Contact ({
                    id: user,
                    type: Constants.CONTACT_TYPE.AGENT,
                    name : user,
                    availability: "AVAILABLE"
                }))
            }
        })
        let contacts = this.filterContacts(onlineContacts.concat(this.state.phoneContacts), filter) ;
        return this.executeAsync("getPhoneContacts", new PhoneContactsResult({
            contacts, contactTypes: this.state.contactTypes
        }));
    }
    /**
     * add participant to call through a new contact
     * @param {Contact} contact - new contact
     * @param {PhoneCall} call - call to be transferred
     * @param {boolean} isBlindTransfer - True if blind transfering a call and hanging up upon transfer
     */
    async addParticipant(contact, call, isBlindTransfer) {
        if (this.state.activeCalls && Object.keys(this.state.activeCalls).length > 1) {
            const message = `Agent is not available for a transfer call`;
            this.log(message);
            return Promise.reject(new Error(message));
        }
        const parentCall = this.getCall(call);
        let isExternalTransfer;
        if (call.callInfo && call.callInfo.isExternalTransfer !== undefined) {
            isExternalTransfer = call.callInfo.isExternalTransfer;
        } else if(contact) {
            isExternalTransfer = !!contact.phoneNumber;
        }

        let transferCall = await this.createVoiceCall(call.callId, Constants.CALL_TYPE.TRANSFER, call.phoneNumber);
        let transferTo = contact.id;
        if(contact.type === Constants.CONTACT_TYPE.FLOW) {
            let routingInstruction = await this.executeOmniFlow(transferCall, contact.id);
            transferTo = routingInstruction.agent || routingInstruction.queue;
        }
        if (this.state.onlineUsers.includes(transferTo)) {
            this.messageUser(transferTo, USER_MESSAGE.CALL_STARTED, {phoneNumber: parentCall.phoneNumber, callId:transferCall.vendorCallKey, voiceCallId: transferCall.voiceCallId});
        }

        if (isBlindTransfer) {
            const destroyedCall = this.destroyCall(call, Constants.HANGUP_REASON.PHONE_CALL_ENDED);
            this.log("addParticipant - cold transfer (destroyed call)", destroyedCall);
            this.beginWrapup(destroyedCall);
            return this.executeAsync("addParticipant", new ParticipantResult({
                phoneNumber: contact.phoneNumber,
                callInfo: new CallInfo({ isOnHold: false, isExternalTransfer }),
                initialCallHasEnded: true,
                callId: call.callId
            }));
        }

        parentCall.callAttributes.isOnHold = true; //FIXME: remove callAttributes.isOnHold in core, we don't need isOnHold in two places
        parentCall.callInfo.isOnHold = true;
        const parentVoiceCallId = parentCall.callAttributes.voiceCallId;
        const newCall = new Call(Constants.CALL_TYPE.ADD_PARTICIPANT, contact, { participantType: Constants.PARTICIPANT_TYPE.THIRD_PARTY, voiceCallId: parentVoiceCallId }, new CallInfo({ isOnHold : false, isExternalTransfer, callStateTimestamp: new Date() }));
        newCall.parentCallId = parentCall.callId;
        newCall.callAttributes.isOnHold = false; // same FIXME
        newCall.state = Constants.CALL_STATE.TRANSFERRING;
        this.log("addParticipant to parent voiceCall " + parentVoiceCallId, newCall);
        this.addCall(parentCall);
        this.addCall(newCall);
        const removeParticipantVariant = this.state.updateRemoveTransferCallParticipantVariant;
        return this.executeAsync("addParticipant", new ParticipantResult({
            phoneNumber: contact.phoneNumber,
            callInfo: new CallInfo({ isOnHold: false, isExternalTransfer, removeParticipantVariant }),
            initialCallHasEnded: parentCall.callAttributes && parentCall.callAttributes.initialCallHasEnded,
            callId: newCall.callId
        }));
    }

    executeOmniFlow(call, flowName) {
        return  fetch('/api/executeOmniFlow', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({flowName:flowName, voiceCallId:call.vendorCallKey})
        }).then(response => response.json()).then((payload) => {
            return payload;
        }).catch((err) => {
            return Promise.reject(err);
        });
    }

    /**
     * Create a Voice call
     */
     createVoiceCall(parentCallId, callType, caller) {
        let url = '/api/createVoiceCall?caller=' + caller + '&type=' +  callType  + (parentCallId ? '&parentCallId=' + parentCallId : '');
        return  fetch(url, {
            headers: {
                'Strict-Transport-Security': 'max-age=31536000'
            }
        }).then(response => response.json())
        .then((data) => {
            if (!data.voiceCallId){
                this.log("Could not contact Service Cloud Real Time. VoiceCall will be created by Salesforce Service Degradation Service.")
            }
            return data;
        }).catch((err) => {
            return Promise.reject(err);
        });
    }
    /**
     * connect the last added participant
     */
    connectParticipant(callInfo) {
        const call = this.getCall({callAttributes: { participantType: Constants.PARTICIPANT_TYPE.THIRD_PARTY }});
        call.state = Constants.CALL_STATE.TRANSFERRED;
        this.log("connectParticipant", call);
        this.addCall(call);
        publishEvent({eventType: Constants.EVENT_TYPE.PARTICIPANT_CONNECTED, payload: new ParticipantResult({
            phoneNumber: call.contact.phoneNumber,
            callInfo: new CallInfo({ isOnHold: false , isExternalTransfer: callInfo.isExternalTransfer, removeParticipantVariant: callInfo.removeParticipantVariant }),
            initialCallHasEnded: call.callAttributes && call.callAttributes.initialCallHasEnded,
            callId: call.callId
        })});
    }
    /**
     * connect the last added supervisor
     */
    connectSupervisor() {
        const call = this.getCall({callAttributes: { participantType: Constants.PARTICIPANT_TYPE.SUPERVISOR }});
        call.state = Constants.CALL_STATE.CONNECTED;
        this.log("connectSupervisor", call);
        this.addCall(call);
        publishEvent({ eventType: Constants.EVENT_TYPE.SUPERVISOR_CALL_CONNECTED, payload: new SuperviseCallResult({ call })});
    }

    /**
     * Simulate removing the participantType from the conversation
     * @param {PARTICIPANT_TYPE} participantType need to be removed
     */
    removeParticipant(participantType) {
        const call = this.getCall({callAttributes: { participantType: participantType }});
        const destroyedCall = this.destroyCall(call, Constants.HANGUP_REASON.PHONE_CALL_ENDED);
        this.log("removeParticipant", call);
        const payload = new CallResult({ call: destroyedCall });
        publishEvent({ eventType: Constants.EVENT_TYPE.PARTICIPANT_REMOVED, payload });
        this.state.agentAvailable = Object.keys(this.state.activeCalls).length === 0;
        this.beginWrapup(destroyedCall);
        return this.executeAsync("removeParticipant", payload);
    }

    removeSupervisor() {
        const call = this.getCall({callAttributes: { participantType: Constants.PARTICIPANT_TYPE.SUPERVISOR }});
        const destroyedCall = this.destroyCall(call);
        this.log("removeSupervisor", call);
        const payload = new SupervisorHangupResult({ calls: destroyedCall });
        publishEvent({ eventType: Constants.EVENT_TYPE.SUPERVISOR_HANGUP, payload });
        return this.executeAsync("removeSupervisor", payload);
    }

    /**
     * Simulate connecting caller
     */
    connectCall(callAttributes) {
        const call = this.getCall({callAttributes: { participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER }});
        call.state = Constants.CALL_STATE.CONNECTED;
        call.callAttributes = Object.assign(call.callAttributes, callAttributes);
        call.callAttributes.state = Constants.CALL_STATE.CONNECTED;
        call.callInfo.removeParticipantVariant = callAttributes.removeParticipantVariant;
        this.addCall(call);
        this.log("connectCall", call);
        publishEvent({ eventType: Constants.EVENT_TYPE.CALL_CONNECTED, payload: new CallResult({ call })});
    }
    /**
     * Simulate hanging up the phone from the agent (either decline or end the call from hardphone)
     */
    hangup(reason, agentErrorStatus) {
        let destroyedCalls = this.destroyCalls({callAttributes: { participantType: Constants.PARTICIPANT_TYPE.AGENT }}, reason);
        destroyedCalls.map((call) => { 
            call.callInfo.isSoftphoneCall = false;
            call.agentStatus = agentErrorStatus;
            return call;
        });
        this.state.agentAvailable = Object.keys(this.state.activeCalls).length === 0;
        publishEvent({ eventType: Constants.EVENT_TYPE.HANGUP, payload: new HangupResult({ calls: destroyedCalls })});
        this.beginWrapup(destroyedCalls[0]);
        return this.executeAsync("hangup", destroyedCalls);
    }

    /**
     * begin after call wrap-up
     * @param {PhoneCall} call - call to begin wrap-up
     * 
     * The implementation publishes AFTER_CALL_WORK_STARTED inside a setTimeout to 
     * give demo connector enough time to finish executing HANGUP/END_CALL code/events. 
     */
    beginWrapup(call) {
        setTimeout(()=> {
            if (this.state.agentAvailable) {
                publishEvent({ eventType: Constants.EVENT_TYPE.AFTER_CALL_WORK_STARTED, payload: { callId: call.callId }});
            }
        },0);
    }

    /**
     * 
     * end after call wrap-up
     */
    endWrapup() {
        this.log("endWrapup");
    }

    /**
     * send  message to Voice Call Record Home
     * @param {object} message - Message
     */
    publishMessage(message) {
        this.log("publishMessage", message);
        publishEvent({ eventType: Constants.EVENT_TYPE.MESSAGE, payload: message });
    }
    /**
     * Handle  message received from sfdc component
     * @param {object} message - Message
     */
    handleMessage(message) {
        this.log("handleMessage", message);
    }

    getSignedRecordingUrl(recordingUrl, vendorCallKey, callId) {
        return this.executeAsync("getSignedRecordingUrl", new SignedRecordingUrlResult({
            success: this.state.capabilities.hasSignedRecordingUrl,
            url: this.state.capabilities.signedRecordingUrl,
            duration: parseInt(this.state.capabilities.signedRecordingDuration),
            callId
        }));
    }

    /**
     * Simulate callback
     */
    requestCallback(payload) {
        const { phoneNumber } = payload;
        const callInfo = new CallInfo({ callStateTimestamp: new Date() });
        const call = new PhoneCall({ callId: Math.random().toString(36).substring(7),
            phoneNumber,
            callInfo,
            callType: Constants.CALL_TYPE.CALLBACK.toLowerCase(),
            contact: new Contact({ phoneNumber }),
            callAttributes: { participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER } });
        this.addCall(call);
        publishEvent({ eventType: Constants.EVENT_TYPE.QUEUED_CALL_STARTED, payload: new CallResult({ call })});
    }

    /**
     * Simulate preview call
     */
    previewCall(payload) {
        const { phoneNumber } = payload;
        const callInfo = new CallInfo({ callStateTimestamp: new Date() });
        const call = new PhoneCall({ callId: Math.random().toString(36).substring(7),
            phoneNumber,
            callInfo,
            callType: Constants.CALL_TYPE.OUTBOUND.toLowerCase(),
            contact: new Contact({ phoneNumber }),
            callAttributes: { participantType: Constants.PARTICIPANT_TYPE.INITIAL_CALLER, dialerType: Constants.DIALER_TYPE.OUTBOUND_PREVIEW } });
        this.addCall(call);
        publishEvent({ eventType: Constants.EVENT_TYPE.PREVIEW_CALL_STARTED, payload: new CallResult({ call })});
    }

    /**
     * Simulate update Audio Stats for MOS
     */
    updateAudioStats(audioStats) {
        this.log("updateAudioStats", audioStats);
        let statsArray = [];
        audioStats.stats.forEach(stats => {
            let inputChannelStats;
            let outputChannelStats;
            if (stats.inputChannelStats) {
                inputChannelStats = new StatsInfo(stats.inputChannelStats);
            }
            if (stats.outputChannelStats) {
                outputChannelStats = new StatsInfo(stats.outputChannelStats);
            }
            statsArray.push(new AudioStatsElement({inputChannelStats, outputChannelStats}));
        });
        const payload = new AudioStats({stats: statsArray, callId: audioStats.callId, isAudioStatsCompleted: audioStats.isAudioStatsCompleted});
        publishEvent({ eventType: Constants.EVENT_TYPE.UPDATE_AUDIO_STATS, payload: payload });
    }

    /**
     * cache the value of remove participant variant for the third party transfer participant
     * This allows disabling the remove participant button during the dialing phase of a transfer call. 
     */
    updateRemoveTransferCallParticipantVariant(variant) {
        this.state.updateRemoveTransferCallParticipantVariant = variant;
    }

    publishSetAgentStatus(statusId) {
        publishEvent({ eventType: "SET_AGENT_STATUS", payload: new AgentStatusInfo({statusId}) });
    }

    publishCallBargedInEventToAgents(parentCall) {
        publishEvent({ eventType: "CALL_BARGED_IN", payload: new SupervisedCallInfo(parentCall)});
    }
}
