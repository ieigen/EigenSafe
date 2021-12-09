const {waffle, ethers} = require("hardhat");
import { Wallet, utils, BigNumber, providers } from "ethers";

const chai = require("chai");
const { solidity } = require("ethereum-waffle");
chai.use(solidity);
const { expect } = chai;

import { ModuleRegistry } from "../typechain/ModuleRegistry"
import { ModuleRegistry__factory } from "../typechain/factories/ModuleRegistry__factory"
import { SecurityModule__factory } from "../typechain/factories/SecurityModule__factory";
import { Wallet__factory } from "../typechain/factories/Wallet__factory" 

const helpers = require("./helpers");
const overrides = { gasLimit: 8000000, gasPrice: 10000 }

const provider = waffle.provider

let moduleRegistry
let securityModule
let masterWallet
let wallet1
let owner
let user1
let user2
let user3
let sequenceId
const expireTime = Math.floor((new Date().getTime()) / 1000) + 600; // 60 seconds
const salts = [utils.formatBytes32String('1'), utils.formatBytes32String('2')]

describe("Module Registry", () => {
    before(async () => {
        let factory = await ethers.getContractFactory("ModuleRegistry");
        moduleRegistry = await factory.deploy()
        await moduleRegistry.deployed()
        factory = await ethers.getContractFactory("SecurityModule");
        securityModule = await factory.deploy(moduleRegistry.address)
        await securityModule.deployed()
        console.log("secure module", securityModule.address)

        //register the module
        let res = await moduleRegistry.registerModule(
            securityModule.address,
            ethers.utils.formatBytes32String("SM")
        );
        await res.wait()

        factory = await ethers.getContractFactory("Wallet")
        masterWallet = await factory.deploy()
        await masterWallet.deployed()
        console.log("master wallet", masterWallet.address)

        // FIXME
        owner = await ethers.getSigner()
        user1 = Wallet.createRandom().connect(provider)
        user2 = Wallet.createRandom().connect(provider)
        user3 = Wallet.createRandom().connect(provider)

        console.log("unsorted", user1.address, user2.address, user3.address)
        let signers = [user1, user2, user3]
        signers.sort(function(a, b) { return a.address - b.address })
        user1 = signers[0];
        user2 = signers[1];
        user3 = signers[2];

        console.log("sorted", user1.address, user2.address, user3.address)

        let proxy = await (await ethers.getContractFactory("Proxy")).deploy(masterWallet.address);
        let walletAddress = await proxy.getAddress(salts[0]);
        expect(walletAddress).to.exist;
        console.log("proxy wallet", walletAddress)

        const tx = await proxy.create(salts[0]);
        await tx.wait()

        wallet1 = Wallet__factory.connect(walletAddress, owner)
        console.log("wallet address", wallet1.address)

        let modules = [ securityModule.address ]
        let encoder = ethers.utils.defaultAbiCoder
        let data = [encoder.encode(["address[]", "uint"], [[user1.address, user2.address], 2])]
        let initTx = await wallet1.initialize(modules, data);
        await initTx.wait()
    })

    beforeEach(async function() {
        await (await owner.sendTransaction({to: user1.address, value: ethers.utils.parseEther("1")})).wait()
        await (await owner.sendTransaction({to: user2.address, value: ethers.utils.parseEther("1")})).wait()
        await (await owner.sendTransaction({to: user3.address, value: ethers.utils.parseEther("1")})).wait()
        // deposit to wallet
        let depositAmount = ethers.utils.parseEther("0.1")
        await owner.sendTransaction({to: wallet1.address, value: depositAmount})
        console.log("before done")
        sequenceId = await wallet1.getNextSequenceId()
        console.log("sequenceId", sequenceId)
    })

    it("should trigger recovery", async function() {
       let sm = SecurityModule__factory.connect(securityModule.address, user1)
       let tx = await sm.triggerRecovery(wallet1.address, user3.address, overrides);
       await tx.wait()

       let res = await sm.isInRecovery(wallet1.address)
       expect(res).eq(true)

       tx = await sm.cancelRecovery(wallet1.address)
       await tx.wait()

       res = await sm.isInRecovery(wallet1.address)
       expect(res).eq(false)

       // should revert
    });

    it("should revert recovery", async function() {
        let sm = SecurityModule__factory.connect(securityModule.address, user3)
        try {
            await sm.triggerRecovery(wallet1.address, user3.address, overrides)
            throw new Error("unreachable")
        } catch (e) {}
    })

    it("should execute recovery", async () => {
        let res1 = await securityModule.isSigner(wallet1.address, user1.address);
        expect(res1).eq(true)
        res1 = await securityModule.isSigner(wallet1.address, user2.address);
        expect(res1).eq(true)

        res1 = await securityModule.isSigner(wallet1.address, user3.address);
        expect(res1).eq(false)

        res1 = await wallet1.owner();
        expect(res1).eq(owner.address)

        let amount = 0
        let sm = SecurityModule__factory.connect(securityModule.address, user1)
        let tx = await sm.triggerRecovery(wallet1.address, user3.address, overrides);
        await tx.wait()

        let SMABI = [
            "function executeRecovery(address)"
        ]
        let iface = new ethers.utils.Interface(SMABI)
        //make replaceOwner caller
        let replaceOwnerData = iface.encodeFunctionData("executeRecovery", [wallet1.address])
        console.log("replaceOwnerData", replaceOwnerData)

        //make signature
        let hash = await helpers.signHash(securityModule.address, amount, replaceOwnerData, /*expireTime,*/ sequenceId)

        let signatures = await helpers.getSignatures(
            ethers.utils.arrayify(hash), [user1, user2])
        console.log(signatures.length, signatures)

        let res = await securityModule.connect(user1).multicall(
            wallet1.address,
            [securityModule.address, amount, replaceOwnerData, sequenceId],
            signatures,
            overrides
        );
        await res.wait()
        //await expect(res).to.emit(wallet1, "MultiCalled")
        res1 = await wallet1.owner();
        expect(res1).eq(user3.address)
    })

    it("should lock", async() => {
        let tx
        try {
            tx = await securityModule.lock(wallet1.address, overrides)
            throw new Error("unreachable")
        } catch (e) {}

        tx = await securityModule.connect(user1).lock(wallet1.address, overrides)
        await tx.wait()

        try{
            await securityModule.connect(user1).lock(wallet1.address, overrides)
            throw new Error("unreachable")
        } catch(e) {}

        tx = await securityModule.connect(user1).unlock(wallet1.address, overrides)
        await tx.wait()
    })

    it("should change signer", async() => {
        let res1 = await securityModule.isSigner(wallet1.address, user1.address);
        expect(res1).eq(true)
        res1 = await securityModule.isSigner(wallet1.address, user2.address);
        expect(res1).eq(true)
        let tx = await securityModule.connect(owner).replaceSigner(
            wallet1.address, user3.address, user1.address, overrides)
        await tx.wait()
        res1 = await securityModule.isSigner(wallet1.address, user1.address);
        expect(res1).eq(false)
        res1 = await securityModule.isSigner(wallet1.address, user2.address);
        expect(res1).eq(true)
        res1 = await securityModule.isSigner(wallet1.address, user3.address);
        expect(res1).eq(true)
    })
});