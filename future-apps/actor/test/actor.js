const Actor = artifacts.require('Actor')

const { assertRevert, assertInvalidOpcode } = require('@aragon/test-helpers/assertThrow')
const { hash } = require('eth-ens-namehash')
const getBalance = require('@aragon/test-helpers/balance')(web3)
const web3Call = require('@aragon/test-helpers/call')(web3)
const { encodeCallScript, EMPTY_SCRIPT } = require('@aragon/test-helpers/evmScript')
const assertEvent = require('@aragon/test-helpers/assertEvent')
const ethABI = require('web3-eth-abi')
const getEvent = (receipt, event, arg) => { return receipt.logs.filter(l => l.event == event)[0].args[arg] }

const ACL = artifacts.require('ACL')
const AppProxyUpgradeable = artifacts.require('AppProxyUpgradeable')
const EVMScriptRegistryFactory = artifacts.require('EVMScriptRegistryFactory')
const DAOFactory = artifacts.require('DAOFactory')
const Kernel = artifacts.require('Kernel')
const KernelProxy = artifacts.require('KernelProxy')

const EtherTokenConstantMock = artifacts.require('EtherTokenConstantMock')
const KernelDepositableMock = artifacts.require('KernelDepositableMock')

const ExecutionTarget = artifacts.require('ExecutionTarget')

const NULL_ADDRESS = '0x00'

contract('Actor app', (accounts) => {
  let daoFact, actorBase, acl, actor, actorId

  let ETH, ANY_ENTITY, APP_MANAGER_ROLE, EXECUTE_ROLE, RUN_SCRIPT_ROLE

  const root = accounts[0]

  const encodeFunctionCall = (contract, functionName, ...params) =>
    contract[functionName].request(...params).params[0]

  before(async () => {
    const kernelBase = await Kernel.new(true) // petrify immediately
    const aclBase = await ACL.new()
    const regFact = await EVMScriptRegistryFactory.new()
    daoFact = await DAOFactory.new(kernelBase.address, aclBase.address, regFact.address)
    actorBase = await Actor.new()

    // Setup constants
    ANY_ENTITY = await aclBase.ANY_ENTITY()
    APP_MANAGER_ROLE = await kernelBase.APP_MANAGER_ROLE()
    EXECUTE_ROLE = await actorBase.EXECUTE_ROLE()
    RUN_SCRIPT_ROLE = await actorBase.RUN_SCRIPT_ROLE()

    const ethConstant = await EtherTokenConstantMock.new()
    ETH = await ethConstant.getETHConstant()
  })

  beforeEach(async () => {
    const r = await daoFact.newDAO(root)
    const dao = Kernel.at(getEvent(r, 'DeployDAO', 'dao'))
    acl = ACL.at(await dao.acl())

    await acl.createPermission(root, dao.address, APP_MANAGER_ROLE, root, { from: root })

    // actor
    actorAppId = hash('actor.aragonpm.test')

    const actorReceipt = await dao.newAppInstance(actorAppId, actorBase.address, '0x', false)
    const actorProxyAddress = getEvent(actorReceipt, 'NewAppProxy', 'proxy')
    actor = Actor.at(actorProxyAddress)

    await actor.initialize()
  })

  context('executing actions', () => {
    const [nonExecutor, executor] = accounts
    let executionTarget

    beforeEach(async () => {
      await acl.createPermission(executor, actor.address, EXECUTE_ROLE, root, { from: root })

      executionTarget = await ExecutionTarget.new()
    })

    it('can execute actions', async () => {
      const N = 1102

      assert.equal(await executionTarget.counter(), 0)

      const { to, data } = encodeFunctionCall(executionTarget, 'setCounter', N)
      const receipt = await actor.execute(to, 0, data, { from: executor })

      assert.equal(await executionTarget.counter(), N)
      assertEvent(receipt, 'Execute')
    })

    it('fails to execute without permissions', async () => {
      const { to, data } = encodeFunctionCall(executionTarget, 'execute')

      await assertRevert(() =>
        actor.execute(to, 0, data, { from: nonExecutor })
      )
    })

    it('fails to execute when target is not a contract', async () => {
      const nonContract = accounts[8] // random account
      const randomData = '0x12345678'
      const noData = '0x'

      await assertRevert(() =>
        actor.execute(nonContract, 0, randomData, { from: executor })
      )

      await assertRevert(() =>
        actor.execute(nonContract, 0, noData, { from: executor })
      )
    })

    it('execution forwards success return data', async () => {
      const { to, data } = encodeFunctionCall(executionTarget, 'execute')

      // We make a call to easily get what data could be gotten inside the EVM
      // Contract -> Actor.execute -> Target.func (would allow Contract to have access to this data)
      assert.equal(await executionTarget.counter(), 0)
      const call = encodeFunctionCall(actor, 'execute', to, 0, data, { from: executor })
      const returnData = await web3Call(call)

      assert.equal(ethABI.decodeParameter('uint256', returnData), 1)
    })

    it('it reverts if executed action reverts', async () => {
      // TODO: Check revert data was correctly forwarded
      // ganache currently doesn't support fetching this data

      const { to, data } = encodeFunctionCall(executionTarget, 'fail')

      await assertRevert(() =>
        actor.execute(to, 0, data, { from: executor })
      )
    })

    context('with ETH:', () => {
      const depositValue = 3
      let to, data

      beforeEach(async () => {
        await actor.deposit(ETH, depositValue, { value: depositValue })

        const call = encodeFunctionCall(executionTarget, 'execute')
        to = call.to
        data = call.data

        assert.equal(await executionTarget.counter(), 0)
        assert.equal(await getBalance(executionTarget.address), 0)
        assert.equal(await getBalance(actor.address), depositValue)
      })

      it('can execute actions with ETH', async () => {
        await actor.execute(to, depositValue, data, { from: executor })

        assert.equal(await executionTarget.counter(), 1)
        assert.equal(await getBalance(executionTarget.address), depositValue)
        assert.equal(await getBalance(actor.address), 0)
      })

      it('fails to execute actions with more ETH than the actor owns', async () => {
        await assertRevert(() =>
          actor.execute(to, depositValue + 1, data, { from: executor })
        )
      })

      it('fails to execute when sending ETH and no data', async () => {
        await assertRevert(() =>
          actor.execute(to, depositValue, '0x', { from: executor })
        )
      })
    })
  })

  context('running scripts', () => {
    let executionTarget, script
    const [nonScriptRunner, scriptRunner] = accounts

    beforeEach(async () => {
      executionTarget = await ExecutionTarget.new()
      // prepare script
      const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
      script = encodeCallScript([action, action]) // perform action twice

      await acl.createPermission(scriptRunner, actor.address, RUN_SCRIPT_ROLE, root, { from: root })
    })

    it('runs script', async () => {
      assert.isTrue(await actor.canForward(scriptRunner, script))
      assert.equal(await executionTarget.counter(), 0)

      const receipt = await actor.forward(script, { from: scriptRunner })

      assert.equal(await executionTarget.counter(), 2)
      assertEvent(receipt, 'ScriptResult')
    })

    it('fails to run script without permissions', async () => {
      assert.isFalse(await actor.canForward(nonScriptRunner, script))

      await assertRevert(() =>
        actor.forward(script, { from: nonScriptRunner })
      )
    })
  })
})
