// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title Central City fee router
 * @notice Takes the Central City protocol fee (10%) on agent payments and emits one FeeCharged
 * event per payment, so every fee is verifiable on-chain and countable by public dashboards.
 *
 * Two paths:
 *  - chargeFee: fee ON TOP for external services. The payer already paid the seller the listed
 *    price through x402; this pulls 10% of that price from the payer to the treasury.
 *  - pay: fee INCLUDED for Central City agent to Central City agent. Pulls the gross price from the
 *    payer, sends 90% to the seller and 10% to the treasury in the same call.
 *
 * Immutable and ownerless: no admin, no upgrade, no pause, no withdraw. Funds move straight from the
 * payer to the seller and the treasury with transferFrom; this contract never holds a balance.
 * Each (payer, ref) pair can be charged once, so a retried payment can never pay the fee twice. The
 * pair stores a commitment to (payee, kind, gross, fee): an identical retry reverts AlreadyCharged,
 * a retry with any field changed reverts RefMismatch. A revert alone never proves a payment; the
 * caller confirms from the FeeCharged event.
 *
 * The cap is fixed in code: one payment never takes more than MAX_TOTAL from the payer, fee
 * included (fee on top: gross + fee <= MAX_TOTAL; fee included: gross <= MAX_TOTAL).
 */
contract CentralCityFeeRouter {
    /// @notice Fee in basis points of the gross price: 10%.
    uint256 public constant FEE_BPS = 1_000;
    uint8 public constant KIND_EXTERNAL = 0;
    uint8 public constant KIND_INTERNAL = 1;

    /// @notice The only accepted token (USDC on Base).
    IERC20 public immutable token;
    /// @notice The only fee recipient.
    address public immutable treasury;
    /// @notice Most one payment may take from the payer, fee included: $0.10 in USDC units.
    uint256 public constant MAX_TOTAL = 100_000;
    /// @notice Smallest price of a fee-included (Central City) service: $0.05 in USDC units.
    uint256 public constant MIN_INCLUDED = 50_000;

    /// @notice Commitment to (payee, kind, gross, fee) per (payer, ref); zero = not charged.
    mapping(address => mapping(bytes32 => bytes32)) public charged;

    /**
     * @param payer  the agent wallet that paid
     * @param payee  the seller that received the price (or its 90%)
     * @param ref    the payment reference (Central City payment intent id hash)
     * @param kind   KIND_EXTERNAL (fee on top) or KIND_INTERNAL (fee included)
     * @param gross  the service price in token units (what the buyer paid for the service)
     * @param fee    the protocol fee sent to the treasury in token units
     */
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
    error TransferFailed();

    constructor(IERC20 token_, address treasury_) {
        if (address(token_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        token = token_;
        treasury = treasury_;
    }

    /// @notice The fee for a gross price, rounded down.
    function feeFor(uint256 gross) public pure returns (uint256) {
        return (gross * FEE_BPS) / 10_000;
    }

    /// @notice Fee on top for an external service already paid through x402.
    function chargeFee(address payee, uint256 gross, bytes32 ref) external returns (uint256 fee) {
        fee = _start(payee, KIND_EXTERNAL, gross, ref);
        _pull(msg.sender, treasury, fee);
        emit FeeCharged(msg.sender, payee, ref, KIND_EXTERNAL, gross, fee);
    }

    /// @notice Fee included: pays the seller 90% and the treasury 10% of the gross price.
    function pay(address payee, uint256 gross, bytes32 ref) external returns (uint256 fee) {
        fee = _start(payee, KIND_INTERNAL, gross, ref);
        _pull(msg.sender, payee, gross - fee);
        _pull(msg.sender, treasury, fee);
        emit FeeCharged(msg.sender, payee, ref, KIND_INTERNAL, gross, fee);
    }

    function _start(address payee, uint8 kind, uint256 gross, bytes32 ref) private returns (uint256 fee) {
        if (payee == address(0) || payee == treasury) revert ZeroAddress();
        if (gross > MAX_TOTAL) revert BadAmount();
        fee = feeFor(gross);
        if (fee == 0) revert BadAmount();
        if (kind == KIND_EXTERNAL && gross + fee > MAX_TOTAL) revert BadAmount();
        if (kind == KIND_INTERNAL && gross < MIN_INCLUDED) revert BadAmount();
        bytes32 commitment = keccak256(abi.encode(payee, kind, gross, fee));
        bytes32 existing = charged[msg.sender][ref];
        if (existing != bytes32(0)) {
            if (existing == commitment) revert AlreadyCharged();
            revert RefMismatch();
        }
        charged[msg.sender][ref] = commitment;
    }

    function _pull(address from, address to, uint256 value) private {
        if (!token.transferFrom(from, to, value)) revert TransferFailed();
    }
}
