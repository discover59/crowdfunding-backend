const logger = require('../../lib/logger')
const postfinanceSHA = require('../../lib/postfinanceSHA')
const uuid = require('uuid/v4')

module.exports = async (_, args, {loaders, pgdb, req, t}) => {
  const transaction = await pgdb.transactionBegin()
  try {
    const { pledge } = args
    const pledgeOptions = pledge.options


    // load original of chosen packageOptions
    const pledgeOptionsTemplateIds = pledgeOptions.map( (plo) => plo.templateId )
    const packageOptions = await transaction.public.packageOptions.find({id: pledgeOptionsTemplateIds})

    // check if all templateIds are valid
    if(packageOptions.length<pledgeOptions.length) {
      logger.error('one or more of the claimed templateIds are/became invalid', { req: req._log(), args })
      throw new Error(t('api/unexpected'))
    }

    // check if packageOptions are all from the same package
    // check if minAmount <= amount <= maxAmount
    // we don't check the pledgeOption price here, because the frontend always
    // sends whats in the templating packageOption, so we always copy the price
    // into the pledgeOption (for record keeping)
    let packageId = packageOptions[0].packageId
    pledgeOptions.forEach( (plo) => {
      const pko = packageOptions.find( (pko) => pko.id===plo.templateId)
      if(packageId!==pko.packageId) {
        logger.error('options must all be part of the same package!', { req: req._log(), args, plo, pko })
        throw new Error(t('api/unexpected'))
      }
      if(!(pko.minAmount <= plo.amount <= pko.maxAmount)) {
        logger.error(`amount in option (templateId: ${plo.templateId}) out of range`, { req: req._log(), args, pko, plo })
        throw new Error(t('api/unexpected'))
      }
    })

    //check total
    const minTotal = Math.max(pledgeOptions.reduce(
      (amount, plo) => {
        const pko = packageOptions.find( (pko) => pko.id===plo.templateId)
        return amount + (pko.userPrice
          ? (pko.minUserPrice * plo.amount)
          : (pko.price * plo.amount))
      }
      , 0
    ), 100)

    if(pledge.total < minTotal) {
      logger.error(`pledge.total (${pledge.total}) must be >= (${total})`, { req: req._log(), args, minTotal })
      throw new Error(t('api/unexpected'))
    }

    //calculate donation
    const regularTotal = Math.max(pledgeOptions.reduce(
      (amount, plo) => {
        const pko = packageOptions.find( (pko) => pko.id===plo.templateId)
        return amount + (pko.price * plo.amount)
      }
      , 0
    ), 100)

    const donation = pledge.total - regularTotal
    // check reason
    if(donation < 0 && !pledge.reason) {
      logger.error('you must provide a reason for reduced pledges', { req: req._log(), args, donation })
      throw new Error(t('api/unexpected'))
    }

    //check user
    let user = null
    let pfAliasId = null
    if(req.user) { //user logged in
      if(req.user.email !== pledge.user.email) {
        logger.error('req.user.email and pledge.user.email dont match, signout first.', { req: req._log(), args })
        throw new Error(t('api/unexpected'))
      }
      user = req.user
      //load possible exising PF alias, only exists if the user is logged in,
      //otherwise he can't have an alias already
      pfAliasId = await transaction.public.paymentSources.findOneFieldOnly({
        userId: user.id,
        method: 'POSTFINANCECARD'
      }, 'pspId')
    } else {
      user = await transaction.public.users.findOne({email: pledge.user.email}) //try to load existing user by email
      if(user && (await transaction.public.pledges.count({userId: user.id}))) { //user has pledges
        return {emailVerify: true}
      } else if(!user) { //create user
        user = await transaction.public.users.insertAndGet({
          email: pledge.user.email,
          firstName: pledge.user.firstName,
          lastName: pledge.user.lastName,
          birthday: pledge.user.birthday
        })
      }
    }
    //update user details
    if(user.firstName !== pledge.user.firstName || user.lastName !== pledge.user.lastName) {
      user = await transaction.public.users.updateAndGetOne({id: user.id}, {
        firstName: pledge.user.firstName,
        lastName: pledge.user.lastName
      })
    }
    //if we didn't load a alias, generate one
    if(!pfAliasId) {
      pfAliasId = uuid()
    }

    //buying reduced is only ok if user doesn't have a pledge yet, except donation only
    if(donation < 0 && await transaction.public.pledges.count({userId: user.id})) {
      const pledges = await transaction.public.pledges.find({userId: user.id})
      const pledgeOptions = await transaction.public.pledgeOptions.find({pledgeId: pledges.map( p => p.id )})
      const packageOptions = await transaction.public.packageOptions.find({id: pledgeOptions.map( p => p.templateId )})
      const rewards = await pgdb.public.rewards.find({id: packageOptions.map( p => p.rewardId )})
      if(rewards.length) {
        logger.info('user tried to buy a reduced membership and already pledged before', { req: req._log(), args })
        throw new Error(t('api/membership/reduced/alreadyHas'))
      }
    }

    //insert pledge
    let newPledge = {
      userId: user.id,
      packageId,
      total: pledge.total,
      donation: donation,
      reason: pledge.reason,
      status: 'DRAFT'
    }
    newPledge = await transaction.public.pledges.insertAndGet(newPledge)

    //insert pledgeOptions
    const newPledgeOptions = await Promise.all(pledge.options.map( (plo) => {
      plo.pledgeId = newPledge.id
      return transaction.public.pledgeOptions.insertAndGet(plo)
    }))
    newPledge.packageOptions = newPledgeOptions

    //commit transaction
    await transaction.transactionCommit()

    //generate PF SHA
    const pfSHA = postfinanceSHA({
      orderId: newPledge.id,
      amount: newPledge.total,
      alias: pfAliasId,
      userId: user.id
    })

    return {
      pledgeId: newPledge.id,
      userId: user.id,
      pfSHA,
      pfAliasId
    }
  } catch(e) {
    await transaction.transactionRollback()
    logger.info('transaction rollback', { req: req._log(), args, error: e })
    throw e
  }
}