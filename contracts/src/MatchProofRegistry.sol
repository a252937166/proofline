// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MatchProofRegistry
/// @notice Append-only evidence commitments for Proofline match decisions.
/// @dev The registry proves that a decision hash was anchored. It does not, by
///      itself, prove that the underlying sporting fact is true.
contract MatchProofRegistry {
    enum ProofState {
        Provisional,
        Verified,
        Disputed,
        Final,
        Rejected
    }

    struct Decision {
        bytes32 matchIdHash;
        bytes32 eventHash;
        bytes32 previousDecisionHash;
        bytes32 decisionHash;
        uint64 revision;
        uint64 observedAt;
        uint64 anchoredAt;
        uint16 confidenceBps;
        ProofState state;
        address anchoredBy;
    }

    uint16 public constant MAX_CONFIDENCE_BPS = 10_000;
    uint16 public constant MIN_VERIFIED_CONFIDENCE_BPS = 8_200;
    uint64 public constant MAX_FUTURE_OBSERVATION_DRIFT = 5 minutes;
    bytes32 public constant REGISTRY_ID = keccak256("proofline.match-proof-registry.v1");

    address public owner;
    address public pendingOwner;
    bool public paused;

    mapping(address => bool) public anchorers;
    mapping(address => bool) public pausers;
    mapping(bytes32 => Decision[]) private decisions;
    mapping(bytes32 => mapping(bytes32 => uint64)) private latestRevisionByEvent;

    error Unauthorized();
    error ZeroAddress();
    error EmptyMatchIdHash();
    error EmptyEventHash();
    error InvalidConfidence(uint16 confidenceBps);
    error VerifiedConfidenceTooLow(uint16 confidenceBps);
    error InvalidObservedAt();
    error ObservedAtInFuture(uint64 observedAt, uint64 maximumAllowed);
    error ContractPaused();
    error ContractNotPaused();
    error DecisionNotFound(bytes32 matchIdHash, uint64 revision);
    error PreviousDecisionHashMismatch(bytes32 expected, bytes32 actual);
    error AlreadyOwner();

    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AnchorerSet(address indexed account, bool allowed);
    event PauserSet(address indexed account, bool allowed);
    event RegistryPaused(address indexed account);
    event RegistryUnpaused(address indexed account);
    event DecisionAnchored(
        bytes32 indexed matchIdHash,
        bytes32 indexed eventHash,
        uint64 indexed revision,
        bytes32 decisionHash,
        bytes32 previousDecisionHash,
        uint16 confidenceBps,
        uint64 observedAt,
        uint64 anchoredAt,
        ProofState state,
        address anchoredBy
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyAnchorer() {
        if (!anchorers[msg.sender]) revert Unauthorized();
        _;
    }

    modifier onlyPauser() {
        if (!pausers[msg.sender] && msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    constructor() {
        owner = msg.sender;
        anchorers[msg.sender] = true;
        pausers[msg.sender] = true;

        emit OwnershipTransferred(address(0), msg.sender);
        emit AnchorerSet(msg.sender, true);
        emit PauserSet(msg.sender, true);
    }

    /// @notice Start a two-step registry administration transfer.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == owner) revert AlreadyOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Accept ownership and rotate the default admin roles atomically.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        anchorers[msg.sender] = true;
        pausers[msg.sender] = true;
        anchorers[previousOwner] = false;
        pausers[previousOwner] = false;
        emit AnchorerSet(previousOwner, false);
        emit PauserSet(previousOwner, false);
        emit AnchorerSet(msg.sender, true);
        emit PauserSet(msg.sender, true);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function setAnchorer(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        anchorers[account] = allowed;
        emit AnchorerSet(account, allowed);
    }

    function setPauser(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        pausers[account] = allowed;
        emit PauserSet(account, allowed);
    }

    function pause() external onlyPauser {
        if (paused) revert ContractPaused();
        paused = true;
        emit RegistryPaused(msg.sender);
    }

    function unpause() external onlyPauser {
        if (!paused) revert ContractNotPaused();
        paused = false;
        emit RegistryUnpaused(msg.sender);
    }

    /// @notice Append a stateful decision while guarding against concurrent writers.
    /// @param expectedPreviousDecisionHash The current latest hash, or zero for the first revision.
    function anchorDecision(
        bytes32 matchIdHash,
        bytes32 eventHash,
        uint16 confidenceBps,
        uint64 observedAt,
        ProofState state,
        bytes32 expectedPreviousDecisionHash
    ) external onlyAnchorer whenNotPaused returns (uint64 revision, bytes32 decisionHash) {
        bytes32 actualPreviousDecisionHash = _latestDecisionHash(matchIdHash);
        if (expectedPreviousDecisionHash != actualPreviousDecisionHash) {
            revert PreviousDecisionHashMismatch(expectedPreviousDecisionHash, actualPreviousDecisionHash);
        }

        return _append(matchIdHash, eventHash, confidenceBps, observedAt, state, actualPreviousDecisionHash);
    }

    /// @notice Convenience entry point used by the Proofline API.
    /// @dev Appends a Verified revision and automatically links it to the latest revision.
    function anchorProof(
        bytes32 matchIdHash,
        bytes32 eventHash,
        uint16 confidenceBps,
        uint64 observedAt
    ) external onlyAnchorer whenNotPaused returns (uint64 revision, bytes32 decisionHash) {
        return _append(
            matchIdHash,
            eventHash,
            confidenceBps,
            observedAt,
            ProofState.Verified,
            _latestDecisionHash(matchIdHash)
        );
    }

    function getRevisionCount(bytes32 matchIdHash) external view returns (uint64) {
        return uint64(decisions[matchIdHash].length);
    }

    /// @notice Return the latest decision for a match.
    /// @dev Reverts when no revision exists so absence cannot be mistaken for a zero-valued proof.
    function getLatest(bytes32 matchIdHash) external view returns (Decision memory) {
        uint256 count = decisions[matchIdHash].length;
        if (count == 0) revert DecisionNotFound(matchIdHash, 0);
        return decisions[matchIdHash][count - 1];
    }

    /// @notice Return a one-indexed immutable revision.
    function getDecision(bytes32 matchIdHash, uint64 revision) external view returns (Decision memory) {
        uint256 count = decisions[matchIdHash].length;
        if (revision == 0 || revision > count) revert DecisionNotFound(matchIdHash, revision);
        return decisions[matchIdHash][revision - 1];
    }

    /// @notice Check the latest revision for this specific event hash.
    /// @return valid True only for matching Verified or Final decisions.
    function verifyProof(
        bytes32 matchIdHash,
        bytes32 eventHash
    ) external view returns (
        bool valid,
        ProofState state,
        uint16 confidenceBps,
        uint64 revision,
        bytes32 decisionHash
    ) {
        revision = latestRevisionByEvent[matchIdHash][eventHash];
        if (revision == 0) return (false, ProofState.Provisional, 0, 0, bytes32(0));

        Decision storage decision = decisions[matchIdHash][revision - 1];
        bool usableState = decision.state == ProofState.Verified || decision.state == ProofState.Final;
        valid = decision.eventHash == eventHash && usableState &&
            decision.confidenceBps >= MIN_VERIFIED_CONFIDENCE_BPS;
        return (
            valid,
            decision.state,
            decision.confidenceBps,
            revision,
            decision.decisionHash
        );
    }

    function _latestDecisionHash(bytes32 matchIdHash) private view returns (bytes32) {
        uint256 count = decisions[matchIdHash].length;
        return count == 0 ? bytes32(0) : decisions[matchIdHash][count - 1].decisionHash;
    }

    function _append(
        bytes32 matchIdHash,
        bytes32 eventHash,
        uint16 confidenceBps,
        uint64 observedAt,
        ProofState state,
        bytes32 previousDecisionHash
    ) private returns (uint64 revision, bytes32 decisionHash) {
        if (matchIdHash == bytes32(0)) revert EmptyMatchIdHash();
        if (eventHash == bytes32(0)) revert EmptyEventHash();
        if (confidenceBps > MAX_CONFIDENCE_BPS) revert InvalidConfidence(confidenceBps);
        if (observedAt == 0) revert InvalidObservedAt();
        if (
            (state == ProofState.Verified || state == ProofState.Final) &&
            confidenceBps < MIN_VERIFIED_CONFIDENCE_BPS
        ) revert VerifiedConfidenceTooLow(confidenceBps);
        uint64 maximumObservedAt = uint64(block.timestamp) + MAX_FUTURE_OBSERVATION_DRIFT;
        if (observedAt > maximumObservedAt) {
            revert ObservedAtInFuture(observedAt, maximumObservedAt);
        }

        revision = uint64(decisions[matchIdHash].length + 1);
        uint64 anchoredAt = uint64(block.timestamp);
        decisionHash = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                matchIdHash,
                eventHash,
                previousDecisionHash,
                revision,
                observedAt,
                anchoredAt,
                confidenceBps,
                state,
                msg.sender
            )
        );

        decisions[matchIdHash].push(
            Decision({
                matchIdHash: matchIdHash,
                eventHash: eventHash,
                previousDecisionHash: previousDecisionHash,
                decisionHash: decisionHash,
                revision: revision,
                observedAt: observedAt,
                anchoredAt: anchoredAt,
                confidenceBps: confidenceBps,
                state: state,
                anchoredBy: msg.sender
            })
        );
        latestRevisionByEvent[matchIdHash][eventHash] = revision;

        emit DecisionAnchored(
            matchIdHash,
            eventHash,
            revision,
            decisionHash,
            previousDecisionHash,
            confidenceBps,
            observedAt,
            anchoredAt,
            state,
            msg.sender
        );
    }
}
