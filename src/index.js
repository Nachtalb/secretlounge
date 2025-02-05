import dude from 'debug-dude'
const { log, info, warn } = dude('bot')

import { version } from '../package.json'
info(`secretlounge v${version} starting`)

import config from '../config.json'

import { connect } from 'coffea'
const networks = connect(config)

import {
  htmlMessage, cursive,
  getUsername, getUsernameFromEvent, getRealnameFromEvent,
  stringifyTimestamp, blacklisted,
  USER_NOT_IN_CHAT, USER_IN_CHAT, USER_BANNED_FROM_CHAT, USER_JOINED_CHAT,
  USER_SPAMMING, ERR_NO_REPLY, ALREADY_UPVOTED, CANT_UPVOTE_OWN_MESSAGE,
  KARMA_THANK_YOU, YOU_HAVE_KARMA, REJOINING_QUICKLY, NOT_AFFILIATION, ALREADY_AFFILIATION,
  AFFILIATION_ADDED, AFFILIATION_REMOVED, USER_REMOVED_DUE_AFFILIATION_CHANGE,
  USER_REMOVED_DUE_AFFILIATION_LEAVE, USER_CANNOT_JOIN_DUE_AFFILIATION
} from './messages'
import { RANKS } from './ranks'
import {
  setCache, delCache, createCacheGroup, getCacheGroup, getFromCache,
  addUpvote, hasUpvoted
} from './cache'
import {
  getUser, getUsers, setRank, isActive, addUser, rejoinUser, updateUser, delUser,
  getSystemConfig, rmWarning, addKarma, karmaOptedOut, addUserSource, delUserSource,
  getUserSource, getUserSources, setLeft
} from './db'
import commands from './commands'
import { HOURS } from './time'
import {
  LINK_REGEX,
  SPAM_LIMIT,
  SPAM_LIMIT_HIT,
  SPAM_INTERVAL,
  SCORE_MESSAGE,
  SCORE_LINK,
  SCORE_STICKER,
  SCORE_CHARACTER,
  WARN_EXPIRE,
  KARMA_PLUS_ONE
} from './constants'

// run a check to see if any warnings need removed every half hour
setInterval(() => {
  getUsers().map((user) => {
    if (user.warnUpdated + WARN_EXPIRE <= Date.now()) {
      rmWarning(user.id)
    }
  })
}, 0.5 * HOURS)

const parseEvent = (rawEvent) => {
  if (typeof rawEvent === 'string') return { type: 'message', text: rawEvent }
  else return rawEvent
}

const isForwarded = (evt) =>
    evt && evt.raw && (evt.raw.forward_from || evt.raw.forward_from_chat)

export const sendTo = (users, rawEvent, alwaysSend = false) => {
  const evt = parseEvent(rawEvent)
  const cacheId = createCacheGroup()
  let replyCache
  if (evt && evt.raw && evt.raw.reply_to_message && evt.raw.reply_to_message.message_id) {
    replyCache = getCacheGroup(evt.raw.reply_to_message.message_id)
  }
  if (evt && evt.options && evt.options.reply_to_message_id) {
    replyCache = getCacheGroup(evt.options.reply_to_message_id)
  }

  users.map((user) => {
    let promises
    if (isActive(user)) {
      if (evt && evt.raw && evt.raw.message_id && user.id === evt.user) {
        setCache(evt.raw.message_id, cacheId, evt.user, user.id)
      }
      if (alwaysSend || user.debug || user.id !== evt.user) { // don't relay back to sender
        if (isForwarded(evt)) {
          promises = networks.send({
            type: 'forwardMessage',
            chat: user.id,
            fromChatId: evt.chat,
            messageId: evt && evt.raw && evt.raw.message_id
          })
        } else {
          promises = networks.send({
            ...evt,
            chat: user.id,
            options: {
              ...evt.options,
              reply_to_message_id: replyCache && replyCache[user.id],
              caption: evt.raw && evt.raw.caption
            }
          })
        }
        if (evt.user) {
          // store message in history
          promises && promises[0] && promises[0].then((msg) => {
            //      (messageId,      cacheId, sender,   receiver)
            setCache(msg.message_id, cacheId, evt.user, user.id)
            setTimeout(() => {
              delCache(msg.message_id)
            }, 24 * HOURS)
          })
          .catch((err) => {
            if (err && (
              err.message === '403 {"ok":false,"error_code":403,"description":"Bot was blocked by the user"}' ||
              err.message === '403 {"ok":false,"error_code":403,"description":"Forbidden: user is deactivated"}' ||
              err.message === '400 {"ok":false,"error_code":400,"description":"PEER_ID_INVALID"}'
            )) {
              info('user (%o) blocked the bot (or user is deactivated), removing from the chat', user)
              delUser(user.id)
            } else {
              warn('message not sent to user (%o): %o', user, err)
            }
          })
        }
      }
    }
  })
}

export const sendToUser = (id, rawEvent) =>
  sendTo(
    [{ id }],
    rawEvent,
    true // alwaysSend
  )

export const sendToAll = (rawEvent) =>
  sendTo(
    getUsers(),
    rawEvent
  )

export const sendToMods = (rawEvent) =>
  sendTo(
    getUsers().filter(u => u.rank >= RANKS.mod),
    rawEvent
  )

export const sendToAdmins = (rawEvent) =>
  sendTo(
    getUsers().filter(u => u.rank >= RANKS.admin),
    rawEvent
  )

const relay = (type) => {
  networks.on(type, (evt, reply) => {
    if (evt && (evt.raw.chat.type === 'group' || evt.raw.chat.type === 'supergroup')) return

    const user = getUser(evt.user)
    if (user && user.rank < 0) return reply(cursive(blacklisted(user && user.reason)))

    if (type !== 'message' || (evt && evt.text && evt.text.charAt(0) !== '/')) { // don't parse commands again
      if ((evt && evt.text === '+1') && (evt && evt.raw && evt.raw.reply_to_message)) {
        return handleKarma(evt, reply)
      }

      const user = getUser(evt.user)
      if (!isActive(user)) { // make sure user is in the group chat
        return reply(cursive(USER_NOT_IN_CHAT))
      } else if (user && user.banned >= Date.now()) {
        return reply(cursive(USER_BANNED_FROM_CHAT + ' ' + stringifyTimestamp(user.banned)))
      }

      if ((user.spamScore + calcSpamScore(evt)) > SPAM_LIMIT) return reply(cursive(USER_SPAMMING))
      else increaseSpamScore(user, evt)

      sendToAll(evt)
    }
  })
}

['message', 'audio', 'document', 'photo', 'sticker', 'video', 'voice'].map(relay)

const updateUserFromEvent = (evt) => {
  const user = getUser(evt.user)
  if (user) {
    if (evt && evt.raw && evt.raw.from) {
      return updateUser(user.id, {
        username: getUsernameFromEvent(evt),
        realname: getRealnameFromEvent(evt)
      })
    } else warn('user detected, but no `from` information in message!')
  }
}

const calcSpamScore = (evt) => {
  switch (evt.type) {
    case 'sticker':
      return SCORE_STICKER
    case 'message':
      if (LINK_REGEX.test(evt.text)) {
        return SCORE_MESSAGE + // regular message
          (evt.text.length * SCORE_CHARACTER) + // characters count, still
          ((evt.text.match(LINK_REGEX) || []).length * SCORE_LINK) // number of links * score
      }

      return SCORE_MESSAGE + (evt.text.length * SCORE_CHARACTER) // regular message + character count
    default:
      return SCORE_MESSAGE
  }
}

const increaseSpamScore = (user, evt) => {
  const incSpamScore = calcSpamScore(evt)
  const newSpamScore =
    (user.spamScore + incSpamScore) >= SPAM_LIMIT
    ? SPAM_LIMIT_HIT
    : user.spamScore + incSpamScore

  return updateUser(user.id, {
    spamScore: newSpamScore
  })
}

const decreaseSpamScores = () => {
  const users = getUsers()
  return users.map((user) => {
    return updateUser(user.id, {
      spamScore: user.spamScore > 0 ? user.spamScore - 1 : 0
    })
  })
}

setInterval(decreaseSpamScores, SPAM_INTERVAL)

const showChangelog = (evt, reply) => {
  const user = getUser(evt.user)
  if (user) {
    if (user.version !== version) {
      updateUser(user.id, { version })
      const tag = 'v' + version.split('-').shift()
      reply(htmlMessage(
        `<i>a new version has been released (</i><b>${version}</b><i>), ` +
        `check out</i> https://github.com/6697/secretlounge/releases/tag/${tag}`
      ))
    }
  }
}

const handleKarma = (evt, reply) => {
  const user = getUser(evt && evt.user)
  const replyId = evt && evt.raw && evt.raw.reply_to_message && evt.raw.reply_to_message.message_id
  const { sender: receiver } = getFromCache(evt, reply)

  if (replyId) {
    if (receiver !== user.id) {
      if (!hasUpvoted(replyId, user.id)) {
        addKarma(receiver, KARMA_PLUS_ONE)
        addUpvote(replyId, user.id)
        if (!karmaOptedOut(receiver)) {
          sendToUser(receiver, {
            ...cursive(YOU_HAVE_KARMA),
            options: {
              reply_to_message_id: replyId,
              parse_mode: 'HTML'
            }
          })
        }
        reply(cursive(KARMA_THANK_YOU))
      } else {
        reply(cursive(ALREADY_UPVOTED))
      }
    } else {
      reply(cursive(CANT_UPVOTE_OWN_MESSAGE))
    }
  } else {
    reply(cursive(ERR_NO_REPLY))
  }
}

const leaveWithMessage = (user, text) => {
  if (!user || user.left) return

  let message = cursive(text)
  message.chat = user.id
  networks.send(message)

  setLeft(user.id, new Date().getTime())
}

const handleSourceRegistration = (evt, reply) => {
  log('Register user source')
  if (!getUserSource(evt.chat)) {
    addUserSource(evt.chat)
    reply(cursive(AFFILIATION_ADDED))
  } else {
    reply(cursive(ALREADY_AFFILIATION))
  }
}

const handleSourceRemoval = (evt, reply) => {
  log('Remove user source')
  if (!getUserSource(evt.chat)) reply(cursive(NOT_AFFILIATION))
  else {
    delUserSource(evt.chat)

    getUsers().map((user) => {
      inUserSource(user.id).then((ok) => {
        if (ok) return
        leaveWithMessage(user, USER_REMOVED_DUE_AFFILIATION_CHANGE)
      })
    })

    reply(cursive(AFFILIATION_REMOVED))
  }
}

async function inUserSource (user) {
  log('Check user sources for user: %d', user)

  const sources = getUserSources()

  if (sources.length == 0) return true

  for (const source of sources) {
    const promises = networks.send({type: 'getChatMember', userId: user, chat: source.id})
    const ok = await promises[0].then((msg) => {
      if (msg.status === 'member' || msg.status === 'administrator' || msg.status === 'creator') return true
    }).catch((err) => {
      log(err)
      return false
    })

    if (ok) return true
  }
  return false
}

networks.on('command', (evt, reply) => {
  log('received command event: %o', evt)

  const user = getUser(evt.user)

  if (
    evt &&
    user && user.rank >= RANKS.admin &&
    (evt.cmd === 'register' || evt.cmd === 'remove') &&
    (evt.raw.chat.type === 'group' || evt.raw.chat.type === 'supergroup')
  ) {
    if (evt && evt.cmd === 'register') handleSourceRegistration(evt, reply)
    if (evt && evt.cmd === 'remove') handleSourceRemoval(evt, reply)
  }

  if (evt && (evt.raw.chat.type === 'group' || evt.raw.chat.type === 'supergroup')) return

  if (evt && evt.cmd) evt.cmd = evt.cmd.toLowerCase()
  if (user && user.rank < 0) return reply(cursive(blacklisted(user && user.reason)))

  if (evt && evt.cmd === 'start') {
    inUserSource(evt.user).then((ok) => {
      if (!ok) return reply(cursive(USER_CANNOT_JOIN_DUE_AFFILIATION))

      if (isActive(user)) return reply(cursive(USER_IN_CHAT))
      else if (!user) addUser(evt.user)
      else rejoinUser(evt.user)

      reply(cursive('You joined the chat!'))

      const newUser = updateUserFromEvent(evt)

      // make first user admin
      if (getUsers().length === 1) setRank(evt.user, RANKS.admin)

      const motd = getSystemConfig().motd
      if (motd) reply(cursive(motd))
    })
  } else if (evt && evt.cmd === '+1') {
    handleKarma(evt, reply)
  } else {
    if (!user) return reply(cursive(USER_NOT_IN_CHAT))

    commands(user, evt, reply)
  }
})

networks.on('channel_post', (evt, reply) => {
  if (evt && evt.text === '/register') handleSourceRegistration(evt, reply)
  if (evt && evt.text === '/remove') handleSourceRemoval(evt, reply)
})

networks.on('message', (evt, reply) => {
  if (evt && (evt.raw.chat.type === 'group' || evt.raw.chat.type === 'supergroup')) return

  updateUserFromEvent(evt)
  showChangelog(evt, reply)
})

networks.on('left_chat_member', (evt, reply) => {
  log('User left a chat: %o', evt)

  const user = getUser(evt.user)

  inUserSource(evt.user).then((ok) => {
    if (!user || user.left || ok) return
    leaveWithMessage(user, USER_REMOVED_DUE_AFFILIATION_LEAVE)
  })
})
