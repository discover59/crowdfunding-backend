exports.seed = async function(knex, Promise) {
  await knex('usersRoles').del()
  await knex('roles').del()
  await knex('users').del()

  let adminsId = await knex('roles').insert({
    name: "admin",
    description: "admins are kind",
    createdAt: new Date(),
    updatedAt: new Date()
  }).returning('id')
  adminsId = parseInt(adminsId)

  let userId = await knex('users').insert({
    email: 'patrick.recher@project-r.construction',
    createdAt: new Date(),
    updatedAt: new Date()
  }).returning('id')
  userId = parseInt(userId)

  await knex('usersRoles').insert({
    userId: userId,
    roleId: adminsId,
    createdAt: new Date(),
    updatedAt: new Date()
  })
}