// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @dev Base USDC (FiatToken v2.2): EIP-3009 with the bytes-signature overload, which verifies an
/// EOA signature or, for a contract wallet, ERC-1271.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/**
 * @title Central City fee router 3 (x402 settlement, fee included, up to 100 USDC)
 * @notice Settles a Central City service payment in one transaction from two EIP-3009
 * authorizations the buyer signed off-chain: 90% of the price to the seller and 10% to the
 * treasury, and emits one FeeCharged event per payment, like routers 1 and 2.
 *
 * Why two authorizations: both transfers go straight from the buyer to the seller and to the
 * treasury, so the router never holds a balance and every unit moves once. Anyone may submit a
 * settlement (an x402 facilitator does); only the buyer's signatures move money.
 *
 * Binding: the router derives both EIP-3009 nonces from (chain, router, treasury, payer, payee,
 * gross, ref, validAfter, validBefore) and the leg. A signature made for any other purchase, amount, recipient, window or leg does not
 * verify, so the two legs always belong to one purchase. Each signature is still a standard
 * EIP-3009 authorization that its holder could submit to USDC directly; a leg used that way makes
 * settle revert (nonce used) and must be reconciled as a partial payment, never re-signed. Each nonce is usable once (EIP-3009) and
 * each (payer, ref) once here, so a payment can never be settled twice.
 *
 * Immutable and ownerless: no admin, no upgrade, no pause, no withdraw. The cap is fixed in code:
 * one payment never moves more than MAX_TOTAL from the payer, fee included.
 */
contract CentralCityFeeRouter3 {
    /// @notice Fee in basis points of the gross price: 10%.
    uint256 public constant FEE_BPS = 1_000;
    /// @notice FeeCharged kind: fee included (the same meaning as routers 1 and 2).
    uint8 public constant KIND_INTERNAL = 1;
    /// @notice Most one payment may move from the payer, fee included: $100 in USDC units.
    uint256 public constant MAX_TOTAL = 100_000_000;
    /// @notice Smallest price of a fee-included service: $0.05 in USDC units.
    uint256 public constant MIN_INCLUDED = 50_000;
    /// @notice Domain tag of the derived nonces.
    bytes32 public constant NONCE_TAG = keccak256("centralcity.router3.settle.v1");
    uint8 public constant LEG_SELLER = 0;
    uint8 public constant LEG_FEE = 1;

    /// @notice The only accepted token (USDC on Base).
    IERC3009 public immutable token;
    /// @notice The only fee recipient.
    address public immutable treasury;

    /// @notice Commitment to (payee, gross, fee) per (payer, ref); zero = not settled.
    mapping(address => mapping(bytes32 => bytes32)) public charged;

    struct Settlement {
        address payer;
        address payee;
        uint256 gross;
        bytes32 ref;
        uint256 validAfter;
        uint256 validBefore;
        bytes sellerSignature;
        bytes feeSignature;
    }

    /// @dev The same event as routers 1 and 2, so ledgers and dashboards read it unchanged.
    event FeeCharged(
        address indexed payer,
        address indexed payee,
        bytes32 indexed ref,
        uint8 kind,
        uint256 gross,
        uint256 fee
    );

    error ZeroAddress();
    error BadAmount();
    error AlreadyCharged();
    error RefMismatch();

    constructor(IERC3009 token_, address treasury_) {
        if (address(token_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        token = token_;
        treasury = treasury_;
    }

    /// @notice The fee for a gross price, rounded down.
    function feeFor(uint256 gross) public pure returns (uint256) {
        return (gross * FEE_BPS) / 10_000;
    }

    /// @notice The EIP-3009 nonce the buyer signs for one leg of one purchase. It binds the chain,
    /// this router and its treasury, the payer, payee, price, ref, both validity bounds and the leg.
    function nonceFor(
        address payer,
        address payee,
        uint256 gross,
        bytes32 ref,
        uint256 validAfter,
        uint256 validBefore,
        uint8 leg
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    NONCE_TAG,
                    block.chainid,
                    address(this),
                    treasury,
                    payer,
                    payee,
                    gross,
                    ref,
                    validAfter,
                    validBefore,
                    leg
                )
            );
    }

    /// @notice Settles one payment: 90% to the seller, 10% to the treasury, one FeeCharged.
    function settle(Settlement calldata s) external returns (uint256 fee) {
        fee = _settle(s);
    }

    /// @notice Settles several payments in one transaction; any failure reverts the whole batch
    /// (the facilitator then settles them one by one).
    function settleBatch(Settlement[] calldata batch) external {
        for (uint256 i = 0; i < batch.length; i++) _settle(batch[i]);
    }

    function _settle(Settlement calldata s) private returns (uint256 fee) {
        if (
            s.payer == address(0) ||
            s.payee == address(0) ||
            s.payee == treasury ||
            s.payee == s.payer ||
            s.payer == treasury
        ) revert ZeroAddress();
        if (s.gross > MAX_TOTAL || s.gross < MIN_INCLUDED) revert BadAmount();
        fee = feeFor(s.gross);
        if (fee == 0) revert BadAmount();
        bytes32 commitment = keccak256(abi.encode(s.payee, s.gross, fee));
        bytes32 existing = charged[s.payer][s.ref];
        if (existing != bytes32(0)) {
            if (existing == commitment) revert AlreadyCharged();
            revert RefMismatch();
        }
        charged[s.payer][s.ref] = commitment;
        _leg(s, s.payee, s.gross - fee, LEG_SELLER, s.sellerSignature);
        _leg(s, treasury, fee, LEG_FEE, s.feeSignature);
        emit FeeCharged(s.payer, s.payee, s.ref, KIND_INTERNAL, s.gross, fee);
    }

    /// @dev One leg: a transfer straight from the payer, with the nonce this router derives.
    function _leg(
        Settlement calldata s,
        address to,
        uint256 value,
        uint8 leg,
        bytes calldata signature
    ) private {
        bytes32 nonce = nonceFor(s.payer, s.payee, s.gross, s.ref, s.validAfter, s.validBefore, leg);
        token.transferWithAuthorization(s.payer, to, value, s.validAfter, s.validBefore, nonce, signature);
    }
}
