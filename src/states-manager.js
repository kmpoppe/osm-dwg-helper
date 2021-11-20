import {
	getOsmMessageIdFromUrl,
	getOsmIssueIdFromUrl,
	isOsmUserUrl,
	getOtrsTicketId
} from './utils.js'

// tab objects expected to have fields: id, url, active
export default class StatesManager {
	constructor() {
		this.tabStates=new Map()
		this.previousTabId=undefined
	}
	clearTabs() {
		this.tabStates.clear()
	}
	deleteTab(tabId) {
		this.tabStates.delete(tabId) // TODO what if onUpdated runs after onRemoved?
		if (this.previousTabId==tabId) this.previousTabId=undefined
	}
	getTabState(tabId) {
		return this.tabStates.get(tabId)
	}
	// need to be aware of race conditions in async functions
	// because of browser onActivated and onUpdated ~simultaneous events
	async updateTabStatesBecauseSettingsChanged(settings,permissions,activeTabs,getTab,addListenerAndSendMessage) {
		const messagedTabIds=[]
		let metPreviousTab=this.previousTabId==null
		for (const tab of activeTabs) {
			if (tab.id==this.previousTabId) {
				metPreviousTab=true
			}
			await this.pushIfChangedAndActive(settings,permissions,tab,addListenerAndSendMessage,messagedTabIds)
		}
		if (!metPreviousTab) {
			const previousTab=await getTab(this.previousTabId)
			const previousTabState=await getTabState(settings,permissions,previousTab,addListenerAndSendMessage)
			this.tabStates.set(this.previousTabId,previousTabState)
		}
		return this.getMessageArgs(messagedTabIds)
	}
	async updateTabStatesBecauseBrowserTabActivated(settings,permissions,tabId,previousTabId,getTab,addListenerAndSendMessage) {
		this.previousTabId=previousTabId
		if (previousTabId!=null && !this.tabStates.get(previousTabId)) {
			const previousTab=await getTab(previousTabId)
			const previousTabState=await getTabState(settings,permissions,previousTab,addListenerAndSendMessage)
			this.tabStates.set(previousTabId,previousTabState)
		}
		if (!this.tabStates.get(tabId)) {
			const tab=await getTab(tabId)
			const tabState=await getTabState(settings,permissions,tab,addListenerAndSendMessage)
			this.tabStates.set(tabId,tabState)
		}
		return this.getMessageArgs([tabId]) // active + result of tab switch
	}
	async updateTabStateBecauseBrowserTabUpdated(settings,permissions,tab,addListenerAndSendMessage) {
		const messagedTabIds=[]
		await this.pushIfChangedAndActive(settings,permissions,tab,addListenerAndSendMessage,messagedTabIds)
		return this.getMessageArgs(messagedTabIds)
	}
	async updateTabStateBecauseNewPanelOpened(settings,permissions,tab,addListenerAndSendMessage) {
		const tabState=await getTabState(settings,permissions,tab,addListenerAndSendMessage)
		this.tabStates.set(tab.id,tabState)
		return this.getMessageArgs([tab.id])
	}
	/**
	 * @private
	 */
	async pushIfChangedAndActive(settings,permissions,tab,addListenerAndSendMessage,messagedTabIds) {
		let oldTabState=this.tabStates.get(tab.id)
		if (oldTabState==null) {
			this.tabStates.set(tab.id,oldTabState={})
		}
		const tabState=await getTabState(settings,permissions,tab,addListenerAndSendMessage)
		const tabStateChanged=!isTabStateEqual(oldTabState,tabState)
		this.tabStates.set(tab.id,tabState)
		if (tabStateChanged && tab.active) {
			messagedTabIds.push(tab.id)
		}
	}
	/**
	 * @private
	 * @returns {[Array.<number>,?number,Object.<number,Object>]} message data: tab ids to update, other tab id, tab states
	 */
	getMessageArgs(tabIds) {
		const messagedTabStates={}
		for (const tabId of tabIds) {
			messagedTabStates[tabId]=this.tabStates.get(tabId)
		}
		if (this.previousTabId!=null) {
			messagedTabStates[this.previousTabId]=this.tabStates.get(this.previousTabId)
		}
		return [tabIds,this.previousTabId,messagedTabStates]
	}
}

async function getTabState(settings,permissions,tab,addListenerAndSendMessage) {
	const tabState={}
	if (settings.osm) {
		const messageId=getOsmMessageIdFromUrl(settings.osm,tab.url)
		if (messageId!=null) {
			tabState.type='message'
			tabState.messageData={
				osmRoot:settings.osm,
				id:messageId,
				url:tab.url
			}
			if (permissions.osm) {
				const contentMessageData=await addListenerAndSendMessage(tab.id,'message',{action:'getMessageData'})
				if (contentMessageData) Object.assign(tabState.messageData,contentMessageData)
			}
		}
	}
	if (settings.osm) {
		const issueId=getOsmIssueIdFromUrl(settings.osm,tab.url)
		if (issueId!=null) {
			tabState.type='issue'
			tabState.issueData={
				osmRoot:settings.osm,
				id:issueId,
				url:tab.url
			}
			if (permissions.osm) {
				const contentIssueData=await addListenerAndSendMessage(tab.id,'issue',{action:'getIssueData'})
				if (contentIssueData) Object.assign(tabState.issueData,contentIssueData)
			}
		}
	}
	if (settings.osm) {
		// TODO get username from url - not necessary for now
		if (isOsmUserUrl(settings.osm,tab.url)) {
			tabState.type='user'
			tabState.userData={}
			if (permissions.osm) {
				const userId=await addListenerAndSendMessage(tab.id,'user',{action:'getUserId'})
				if (userId!=null) {
					let apiUrl='#' // not important for now - only used in templates
					if (settings.osm_api) apiUrl=settings.osm_api+'api/0.6/user/'+encodeURIComponent(userId)
					tabState.userData={
						id:userId,
						apiUrl
					}
				}
			}
		}
	}
	if (settings.otrs) {
		const ticketId=getOtrsTicketId(settings.otrs,tab.url)
		if (ticketId!=null) {
			tabState.type='ticket'
			tabState.ticketData={
				id:ticketId,
				url:tab.url
			}
			tabState.issueData={}
			if (settings.osm && permissions.otrs) {
				const contentIssueId=await addListenerAndSendMessage(tab.id,'ticket',{action:'getIssueId'})
				if (contentIssueId!=null) {
					tabState.issueData={
						osmRoot:settings.osm,
						id:contentIssueId,
						url:`${settings.osm}issues/${encodeURIComponent(contentIssueId)}`
					}
				}
			}
		}
	}
	return tabState
}

function isTabStateEqual(data1,data2) {
	if (data1.type!=data2.type) return false
	if (data1.type=='message') {
		if (data1.messageData.id!=data2.messageData.id) return false
	}
	if (data1.type=='user') {
		if (data1.userData.id!=data2.userData.id) return false
	}
	if (data1.type=='issue') {
		if (data1.issueData.id!=data2.issueData.id) return false
		// TODO compare other stuff: data1.issueData.reportedItem
	}
	if (data1.type=='ticket') {
		if (data1.issueData.id!=data2.issueData.id) return false
		// TODO compare other stuff
	}
	return true
}
