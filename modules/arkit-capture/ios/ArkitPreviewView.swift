import ExpoModulesCore
import ARKit
import SceneKit

/// Canli kamera + AR onizlemesi, uzerinde Polycam tarzi tarama agi.
///
/// Onceki surum mesh'i dolu ucgenler halinde, `.add` harmanlama ve derinlik
/// yazmadan ciziyordu. Bu uc secim birlesince tum yuzeyler ust uste toplanip
/// ekrani kaplayan tek parca mavi bir ortu gibi gorunuyordu. Simdi tel kafes
/// olarak, normal alfa harmanlamayla ve derinlik testiyle ciziliyor; boylece
/// yakin yuzeyler uzaktakileri kapatiyor ve kamera goruntusu okunur kaliyor.
class ArkitPreviewView: ExpoView, ARSCNViewDelegate {
    private let sceneView = ARSCNView()

    /// Mesh guncellemelerini kisitla. ARKit her karede onlarca mesh anchor'i
    /// guncelleyebiliyor; hepsi icin SCNGeometry yeniden kurmak tarama
    /// sirasinda belirgin takilmaya yol aciyordu.
    private static let minRebuildInterval: TimeInterval = 0.4
    // In coverage mode a rebuild is two geometries plus a colour lookup per
    // vertex, and ARKit updates dozens of anchors a second while scanning.
    // Rebuilding each at 0.4 s on the render thread is what made the app lag
    // and the phone hot on half a room. Slower per anchor, slower still when
    // iOS reports the phone as hot; what the camera looks at is refreshed
    // separately in updateAtTime.
    private static let coverageRebuildInterval: TimeInterval = 1.5
    private static let hotRebuildInterval: TimeInterval = 4.0

    /// Overlay geometry is built here, off SceneKit's render thread, and
    /// installed on the main thread when ready. At most one build per anchor
    /// is pending; a newer request for a pending anchor is dropped.
    private let overlayQueue = DispatchQueue(label: "arkit-preview.overlay", qos: .utility)
    private let pendingLock = NSLock()
    private var pendingAnchors = Set<UUID>()

    private static var phoneIsHot: Bool {
        ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue
    }
    private var lastRebuild: [UUID: TimeInterval] = [:]
    private var lastCoverageRefresh: TimeInterval = 0
    private var refreshCursor = 0

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        sceneView.session = ArkitSessionHost.shared.session
        sceneView.automaticallyUpdatesLighting = true
        sceneView.delegate = self
        addSubview(sceneView)
        ArkitSessionHost.shared.start()
    }

    deinit {
        // Without this the shared session outlives the screen and keeps LiDAR,
        // mesh reconstruction and the camera running for the life of the app.
        releaseSession()
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        // deinit alone is not enough: React Native can hold the view past the
        // point where it leaves the screen, and the session would keep running
        // until that reference happens to drop.
        if newWindow == nil {
            releaseSession()
        }
    }

    /// Balances the `start()` in init exactly once, whichever teardown path
    /// fires first -- a second decrement would let a live preview's session be
    /// stopped out from under it.
    private var didReleaseSession = false

    private func releaseSession() {
        guard !didReleaseSession else { return }
        didReleaseSession = true
        ArkitSessionHost.shared.stop()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        sceneView.frame = bounds
    }

    // MARK: - Overlay materyali

    /// Tel kafes materyali. Dolu yuzey yerine ag cizmek hem yuzeyin taranmis
    /// oldugunu gosteriyor hem de altindaki kamera goruntusunu kapatmiyor.
    private static let scanMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.diffuse.contents = UIColor(red: 0.25, green: 0.70, blue: 1.0, alpha: 0.9)
        m.emission.contents = UIColor(red: 0.25, green: 0.70, blue: 1.0, alpha: 0.35)
        m.fillMode = .lines
        m.isDoubleSided = true
        m.blendMode = .alpha
        m.lightingModel = .constant
        // Derinlik testi acik: yakin duvar arkadakini kapatiyor, boylece ag
        // sahnenin uzerinde yuzen bir ortu gibi degil, yuzeye yapismis gorunuyor.
        m.readsFromDepthBuffer = true
        m.writesToDepthBuffer = true
        return m
    }()

    // MARK: - Kapsama isi haritasi: tek katman
    //
    // Yari saydam dolu yuzey tek geciste cizilince, kameraya bakan yuzeyin
    // arkasindaki her yuzey (masanin alt yuzu, bacaklar, sandalye, ust uste
    // binen komsu mesh anchor'lari) onun ALTINDA harmanlanip gorunuyordu:
    // bir masa "20 kat" gibi duruyor ve rengi okunmuyordu. SceneKit saydam
    // ucgenleri tek tek siralamaz, bu yuzden derinlik yazmak da yetmedi.
    //
    // Cozum iki gecis:
    //   1. derinlik gecisi: ayni mesh, renk yazmadan, sadece derinlik yazar;
    //      her pikselde en yakin yuzeyin derinligi kalir;
    //   2. renk gecisi: vertex'ler normal yonunde 1 cm kaldirilmis kopya,
    //      derinlik testiyle. Sadece en yakin yuzeyin kaldirilmis hali
    //      testi gecer; arkadakiler gecemez. Renk gecisi de derinlik yazar,
    //      boylece cakisan iki anchor ayni pikselde iki kez boyanmaz.
    // Kaydirma CPU'da yapiliyor (shader degil), cunku shader derleme hatasi
    // ancak cihazda gorulur; bu yol derleyicinin kontrol ettigi Swift.

    private static let depthNodeName = "coverage-depth"
    private static let colorNodeName = "coverage-color"
    private static let wireNodeName = "coverage-wire"
    private static let colorLiftMeters: Float = 0.01

    private static let coverageDepthMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.colorBufferWriteMask = []
        m.isDoubleSided = true
        m.lightingModel = .constant
        m.readsFromDepthBuffer = true
        m.writesToDepthBuffer = true
        return m
    }()

    /// Renk vertex basina CoverageMap'ten geliyor, bu yuzden diffuse beyaz ve
    /// emisyon yok; yari saydamlik vertex alfasindan geliyor.
    private static let coverageMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.diffuse.contents = UIColor.white
        m.fillMode = .fill
        m.transparencyMode = .aOne
        m.isDoubleSided = true
        m.blendMode = .alpha
        m.lightingModel = .constant
        m.readsFromDepthBuffer = true
        m.writesToDepthBuffer = true
        return m
    }()

    /// Kapsama modu icin (derinlik, renk) geometri cifti.
    /// paintCoverage false = only finished pieces are coloured (green); the
    /// plain scanning wire is then drawn as a third, lifted layer.
    private func coverageGeometries(from meshAnchor: ARMeshAnchor, paintCoverage: Bool,
                                    doneBoxes: [DoneBox]) -> (SCNGeometry, SCNGeometry, SCNGeometry?)? {
        let meshGeometry = meshAnchor.geometry
        let vertices = meshGeometry.vertices
        let normals = meshGeometry.normals
        let faces = meshGeometry.faces
        let count = vertices.count
        guard count > 0, faces.count > 0, normals.count == count else { return nil }

        let vertexBytes = vertices.offset + count * vertices.stride
        let normalBytes = normals.offset + count * normals.stride
        let indexBytes = faces.count * faces.indexCountPerPrimitive * faces.bytesPerIndex
        guard vertexBytes <= vertices.buffer.length,
              normalBytes <= normals.buffer.length,
              indexBytes <= faces.buffer.length else { return nil }
        // Copies: ARKit reuses and overwrites its buffers.
        let vertexData = Data(bytes: vertices.buffer.contents(), count: vertexBytes)
        let normalData = Data(bytes: normals.buffer.contents(), count: normalBytes)
        let indexData = Data(bytes: faces.buffer.contents(), count: indexBytes)

        var lifted = [Float](repeating: 0, count: count * 3)
        vertexData.withUnsafeBytes { (v: UnsafeRawBufferPointer) in
            normalData.withUnsafeBytes { (n: UnsafeRawBufferPointer) in
                for i in 0..<count {
                    let vo = vertices.offset + i * vertices.stride
                    let no = normals.offset + i * normals.stride
                    for k in 0..<3 {
                        lifted[i * 3 + k] =
                            v.loadUnaligned(fromByteOffset: vo + k * 4, as: Float.self)
                            + n.loadUnaligned(fromByteOffset: no + k * 4, as: Float.self)
                            * Self.colorLiftMeters
                    }
                }
            }
        }
        let liftedData = lifted.withUnsafeBufferPointer { Data(buffer: $0) }

        let element = SCNGeometryElement(
            data: indexData,
            primitiveType: .triangles,
            primitiveCount: faces.count,
            bytesPerIndex: faces.bytesPerIndex
        )

        let depthSource = SCNGeometrySource(
            data: vertexData,
            semantic: .vertex,
            vectorCount: count,
            usesFloatComponents: true,
            componentsPerVector: 3,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: vertices.offset,
            dataStride: vertices.stride
        )
        let depthGeometry = SCNGeometry(sources: [depthSource], elements: [element])
        depthGeometry.materials = [Self.coverageDepthMaterial]

        let liftedSource = SCNGeometrySource(
            data: liftedData,
            semantic: .vertex,
            vectorCount: count,
            usesFloatComponents: true,
            componentsPerVector: 3,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: 0,
            dataStride: 3 * MemoryLayout<Float>.size
        )
        // Colours from the real surface position, not the lifted one.
        let colors = ArkitSessionHost.shared.coverage.vertexColors(
            vertexData: vertexData,
            offset: vertices.offset,
            stride: vertices.stride,
            count: count,
            anchorTransform: meshAnchor.transform,
            paintCoverage: paintCoverage,
            doneBoxes: doneBoxes
        )
        let colorSource = SCNGeometrySource(
            data: colors,
            semantic: .color,
            vectorCount: count,
            usesFloatComponents: true,
            componentsPerVector: 4,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: 0,
            dataStride: 4 * MemoryLayout<Float>.size
        )
        let colorGeometry = SCNGeometry(sources: [liftedSource, colorSource], elements: [element])
        colorGeometry.materials = [Self.coverageMaterial]
        var wireGeometry: SCNGeometry? = nil
        if !paintCoverage {
            let wire = SCNGeometry(sources: [liftedSource], elements: [element])
            wire.materials = [Self.scanMaterial]
            wireGeometry = wire
        }
        return (depthGeometry, colorGeometry, wireGeometry)
    }

    private func childNode(named name: String, in node: SCNNode, renderingOrder: Int) -> SCNNode {
        if let existing = node.childNode(withName: name, recursively: false) {
            return existing
        }
        let child = SCNNode()
        child.name = name
        // Every depth pass must be drawn before every colour pass.
        child.renderingOrder = renderingOrder
        node.addChildNode(child)
        return child
    }

    /// Builds the right geometry for an anchor on `overlayQueue` and installs
    /// it on the main thread.
    private func scheduleOverlay(for meshAnchor: ARMeshAnchor, on node: SCNNode) {
        pendingLock.lock()
        let alreadyPending = pendingAnchors.contains(meshAnchor.identifier)
        if !alreadyPending { pendingAnchors.insert(meshAnchor.identifier) }
        pendingLock.unlock()
        if alreadyPending { return }

        let host = ArkitSessionHost.shared
        let colored = host.paintsColorMesh
        let paintCoverage = host.paintsCoverage
        let doneBoxes = host.doneBoxes
        overlayQueue.async { [weak self, weak node] in
            guard let self = self else { return }
            let pair = colored
                ? self.coverageGeometries(from: meshAnchor, paintCoverage: paintCoverage, doneBoxes: doneBoxes)
                : nil
            let wire = pair == nil ? self.makeGeometry(from: meshAnchor) : nil
            self.pendingLock.lock()
            self.pendingAnchors.remove(meshAnchor.identifier)
            self.pendingLock.unlock()
            DispatchQueue.main.async {
                guard let node = node else { return }
                if let pair = pair {
                    node.geometry = nil
                    self.childNode(named: Self.depthNodeName, in: node, renderingOrder: -10).geometry = pair.0
                    self.childNode(named: Self.colorNodeName, in: node, renderingOrder: 10).geometry = pair.1
                    if let wire = pair.2 {
                        self.childNode(named: Self.wireNodeName, in: node, renderingOrder: 0).geometry = wire
                    } else {
                        node.childNode(withName: Self.wireNodeName, recursively: false)?.removeFromParentNode()
                    }
                } else if let wire = wire {
                    for child in node.childNodes { child.removeFromParentNode() }
                    node.geometry = wire
                }
            }
        }
    }

    /// Tarama oncesi tel kafes: ARMeshGeometry'yi cizilebilir bir SCNGeometry'ye cevirir.
    ///
    /// Onemli: ARKit'in MTLBuffer'lari yeniden kullanilip uzerine yaziliyor.
    /// Onceki surum `bytesNoCopy` ile bu bellege dogrudan bakiyordu, bu yuzden
    /// zaman zaman bozuk ucgenler ciziliyordu. Burada veriyi kopyaliyoruz.
    private func makeGeometry(from meshAnchor: ARMeshAnchor) -> SCNGeometry? {
        let meshGeometry = meshAnchor.geometry
        let vertices = meshGeometry.vertices
        let faces = meshGeometry.faces
        guard vertices.count > 0, faces.count > 0 else { return nil }

        let vertexBytes = vertices.offset + vertices.count * vertices.stride
        guard vertexBytes <= vertices.buffer.length else { return nil }
        let vertexData = Data(bytes: vertices.buffer.contents(), count: vertexBytes)

        let source = SCNGeometrySource(
            data: vertexData,
            semantic: .vertex,
            vectorCount: vertices.count,
            usesFloatComponents: true,
            componentsPerVector: 3,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: vertices.offset,
            dataStride: vertices.stride
        )

        // Tum buffer uzunlugu yerine gercek indeks sayisini kullan; buffer
        // sonunda kullanilmayan alan olabiliyor ve fazlasi cop ucgen uretiyor.
        let indexBytes = faces.count * faces.indexCountPerPrimitive * faces.bytesPerIndex
        guard indexBytes <= faces.buffer.length else { return nil }
        let indexData = Data(bytes: faces.buffer.contents(), count: indexBytes)

        let element = SCNGeometryElement(
            data: indexData,
            primitiveType: .triangles,
            primitiveCount: faces.count,
            bytesPerIndex: faces.bytesPerIndex
        )

        let geometry = SCNGeometry(sources: [source], elements: [element])
        geometry.materials = [Self.scanMaterial]
        return geometry
    }

    func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return nil }
        let node = SCNNode()
        scheduleOverlay(for: meshAnchor, on: node)
        lastRebuild[anchor.identifier] = CACurrentMediaTime()
        return node
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        let now = CACurrentMediaTime()
        let interval = !ArkitSessionHost.shared.paintsColorMesh ? Self.minRebuildInterval
            : (Self.phoneIsHot ? Self.hotRebuildInterval : Self.coverageRebuildInterval)
        if let last = lastRebuild[anchor.identifier], now - last < interval {
            return
        }
        lastRebuild[anchor.identifier] = now
        scheduleOverlay(for: meshAnchor, on: node)
    }

    /// Mesh anchors only report updates while ARKit is still refining them,
    /// so a surface meshed early would keep its first colour however long it
    /// was filmed afterwards. The old round-robin (6 anchors every 0.5 s)
    /// took several seconds to come back to the surface the user was looking
    /// at, which read as "it never turns yellow". Now every tick recolours the
    /// anchors nearest to the point 1.5 m in front of the camera -- what is on
    /// screen -- plus a couple of others round-robin so nothing stays stale.
    private static let coverageRefreshInterval: TimeInterval = 0.5
    private static let hotRefreshInterval: TimeInterval = 2.0
    private static let nearestPerRefresh = 2
    private static let roundRobinPerRefresh = 1
    private static let lookAheadMeters: Float = 1.5

    func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
        syncObjectOverlays()
        let refreshInterval = Self.phoneIsHot ? Self.hotRefreshInterval : Self.coverageRefreshInterval
        guard ArkitSessionHost.shared.paintsCoverage,
              time - lastCoverageRefresh >= refreshInterval else { return }
        lastCoverageRefresh = time
        let anchors = ArkitSessionHost.shared.currentMeshAnchors()
        guard !anchors.isEmpty else { return }

        var chosen: [ARMeshAnchor] = []
        if let camera = sceneView.session.currentFrame?.camera.transform {
            let position = simd_float3(camera.columns.3.x, camera.columns.3.y, camera.columns.3.z)
            let forward = -simd_float3(camera.columns.2.x, camera.columns.2.y, camera.columns.2.z)
            let target = position + forward * Self.lookAheadMeters
            let nearest = anchors.sorted {
                simd_distance_squared(Self.centre(of: $0), target)
                    < simd_distance_squared(Self.centre(of: $1), target)
            }
            chosen.append(contentsOf: nearest.prefix(Self.nearestPerRefresh))
        }
        for k in 0..<min(Self.roundRobinPerRefresh, anchors.count) {
            let anchor = anchors[(refreshCursor + k) % anchors.count]
            if !chosen.contains(where: { $0.identifier == anchor.identifier }) {
                chosen.append(anchor)
            }
        }
        refreshCursor = (refreshCursor + Self.roundRobinPerRefresh) % anchors.count

        for anchor in chosen {
            guard let node = sceneView.node(for: anchor) else { continue }
            lastRebuild[anchor.identifier] = CACurrentMediaTime()
            scheduleOverlay(for: anchor, on: node)
        }
    }

    // MARK: - Object mode: green pieces and the dome

    private var seenDoneVersion = 0
    private var seenDomeVersion = 0
    private let domeNodeName = "object-dome"

    /// Render thread, once a frame: two int compares. A changed list of
    /// finished pieces recolours every mesh anchor once; a changed dome is
    /// rebuilt on the main thread.
    private func syncObjectOverlays() {
        let host = ArkitSessionHost.shared
        let doneVersion = host.doneVersion
        if doneVersion != seenDoneVersion {
            seenDoneVersion = doneVersion
            for anchor in host.currentMeshAnchors() {
                guard let node = sceneView.node(for: anchor) else { continue }
                lastRebuild[anchor.identifier] = CACurrentMediaTime()
                scheduleOverlay(for: anchor, on: node)
            }
        }
        let dome = host.dome
        if dome.version != seenDomeVersion {
            seenDomeVersion = dome.version
            let json = dome.json
            DispatchQueue.main.async { [weak self] in self?.rebuildDome(json: json) }
        }
    }

    // The dome is drawn in ARKit world coordinates under the scene root. The
    // JSON comes from objectMode.ts domeShell(): the base ellipse at floorY
    // (semi-axis a along the piece's x axis, b along its z axis, rotated by
    // yaw), the apex at topY, 12 azimuth sectors x 3 elevation bands. Ring 0
    // is the lowest band (makeDome puts ring 0 at the farthest viewing
    // distance, i.e. the lowest viewer elevation). Azimuth is world:
    // horizontal direction h = (sin az, 0, -cos az), same as makeDome.
    private static let domeGapDeg: Float = 1.2
    private static let domeSegAz = 4
    private static let domeSegEl = 3

    private static let domeMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.diffuse.contents = UIColor.white
        m.fillMode = .fill
        m.transparencyMode = .aOne
        m.isDoubleSided = true
        m.blendMode = .alpha
        m.lightingModel = .constant
        // Never hides the piece or the mesh behind it.
        m.readsFromDepthBuffer = false
        m.writesToDepthBuffer = false
        return m
    }()

    private static let domeEdgeMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.diffuse.contents = UIColor(white: 1.0, alpha: 0.45)
        m.isDoubleSided = true
        m.blendMode = .alpha
        m.lightingModel = .constant
        m.readsFromDepthBuffer = false
        m.writesToDepthBuffer = false
        return m
    }()

    /// Main thread. nil/invalid JSON just removes the dome.
    private func rebuildDome(json: String?) {
        let root = sceneView.scene.rootNode
        root.childNode(withName: domeNodeName, recursively: false)?.removeFromParentNode()
        guard let json = json, let data = json.data(using: .utf8),
              let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let center = (spec["center"] as? [NSNumber])?.map({ Float(truncating: $0) }), center.count == 3,
              let axesAB = (spec["semiAxes"] as? [NSNumber])?.map({ Float(truncating: $0) }), axesAB.count == 2,
              let slices = spec["slices"] as? [[String: Any]],
              let floorY = (spec["floorY"] as? NSNumber)?.floatValue,
              let topY = (spec["topY"] as? NSNumber)?.floatValue else { return }
        let yaw = (spec["yaw"] as? NSNumber)?.floatValue ?? 0
        let rings = max(1, (spec["rings"] as? NSNumber)?.intValue ?? 3)
        let azCount = max(1, (spec["azimuths"] as? NSNumber)?.intValue ?? 12)

        let ax = simd_float3(cos(yaw), 0, -sin(yaw))
        let az = simd_float3(sin(yaw), 0, cos(yaw))
        let a = axesAB[0]
        let b = axesAB[1]
        let height = topY - floorY
        // Superellipse profile r^p + y^p = 1 (domeShell's `profile`): flatter
        // than an ellipsoid so a flat-topped piece stays inside with the apex
        // at its top.
        let e = 2 / max(2, (spec["profile"] as? NSNumber)?.floatValue ?? 2)
        // Shell point at world azimuth phi and elevation parameter theta (radians).
        func point(_ phi: Float, _ theta: Float) -> SCNVector3 {
            let h = simd_float3(sin(phi), 0, -cos(phi))
            let r = pow(max(0, cos(theta)), e)
            let flat = ax * (a * simd_dot(h, ax) * r) + az * (b * simd_dot(h, az) * r)
            return SCNVector3(center[0] + flat.x, floorY + height * pow(max(0, sin(theta)), e), center[2] + flat.z)
        }

        var positions: [SCNVector3] = []
        var colors: [Float] = []
        var indices: [UInt32] = []
        var edgePositions: [SCNVector3] = []
        var edgeIndices: [UInt32] = []
        let gap = Self.domeGapDeg * Float.pi / 180
        let sectorSpan = 2 * Float.pi / Float(azCount)
        let bandSpan = (Float.pi / 2) / Float(rings)
        let nAz = Self.domeSegAz
        let nEl = Self.domeSegEl

        // Outline of one patch side: a polyline as line segments.
        func border(_ pts: [SCNVector3]) {
            let first = UInt32(edgePositions.count)
            edgePositions.append(contentsOf: pts)
            for k in 0..<(pts.count - 1) {
                edgeIndices.append(contentsOf: [first + UInt32(k), first + UInt32(k) + 1])
            }
        }

        for s in slices {
            guard let ring = (s["ring"] as? NSNumber)?.intValue,
                  let azDeg = (s["azimuth"] as? NSNumber)?.floatValue,
                  ring >= 0, ring < rings else { continue }
            let rgba: (Float, Float, Float, Float)
            switch s["state"] as? String {
            case "filled": rgba = (0.29, 0.87, 0.50, 0.45)
            case "unreachable": rgba = (0.6, 0.6, 0.6, 0.08)
            default: rgba = (1, 1, 1, 0.18)
            }
            let phiMid = azDeg * Float.pi / 180
            let phi0 = phiMid - sectorSpan / 2 + gap
            let phi1 = phiMid + sectorSpan / 2 - gap
            let th0 = Float(ring) * bandSpan + gap
            let th1 = Float(ring + 1) * bandSpan - gap

            // Patch: (nAz+1) x (nEl+1) grid of vertices, two triangles a cell.
            let base = UInt32(positions.count)
            for j in 0...nEl {
                let theta = th0 + (th1 - th0) * Float(j) / Float(nEl)
                for i in 0...nAz {
                    let phi = phi0 + (phi1 - phi0) * Float(i) / Float(nAz)
                    positions.append(point(phi, theta))
                    colors.append(contentsOf: [rgba.0, rgba.1, rgba.2, rgba.3])
                }
            }
            let row = UInt32(nAz + 1)
            for j in 0..<nEl {
                for i in 0..<nAz {
                    let v00 = base + UInt32(j) * row + UInt32(i)
                    let v10 = v00 + 1
                    let v01 = v00 + row
                    let v11 = v01 + 1
                    indices.append(contentsOf: [v00, v10, v11, v00, v11, v01])
                }
            }

            border((0...nAz).map { point(phi0 + (phi1 - phi0) * Float($0) / Float(nAz), th0) })
            border((0...nAz).map { point(phi0 + (phi1 - phi0) * Float($0) / Float(nAz), th1) })
            border((0...nEl).map { point(phi0, th0 + (th1 - th0) * Float($0) / Float(nEl)) })
            border((0...nEl).map { point(phi1, th0 + (th1 - th0) * Float($0) / Float(nEl)) })
        }
        guard !positions.isEmpty else { return }

        let colorData = colors.withUnsafeBufferPointer { Data(buffer: $0) }
        let colorSource = SCNGeometrySource(
            data: colorData,
            semantic: .color,
            vectorCount: positions.count,
            usesFloatComponents: true,
            componentsPerVector: 4,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: 0,
            dataStride: 4 * MemoryLayout<Float>.size
        )
        let fill = SCNGeometry(
            sources: [SCNGeometrySource(vertices: positions), colorSource],
            elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)]
        )
        fill.materials = [Self.domeMaterial]
        let edges = SCNGeometry(
            sources: [SCNGeometrySource(vertices: edgePositions)],
            elements: [SCNGeometryElement(indices: edgeIndices, primitiveType: .line)]
        )
        edges.materials = [Self.domeEdgeMaterial]

        // Drawn after the mesh layers (order 10) so the shell blends over them.
        let node = SCNNode()
        node.name = domeNodeName
        let fillNode = SCNNode(geometry: fill)
        fillNode.renderingOrder = 20
        let edgeNode = SCNNode(geometry: edges)
        edgeNode.renderingOrder = 21
        node.addChildNode(fillNode)
        node.addChildNode(edgeNode)
        root.addChildNode(node)
    }

    private static func centre(of anchor: ARMeshAnchor) -> simd_float3 {
        let t = anchor.transform.columns.3
        return simd_float3(t.x, t.y, t.z)
    }

    func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
        lastRebuild.removeValue(forKey: anchor.identifier)
    }

    // lastRebuild is touched from nodeFor/didUpdate/updateAtTime, which
    // SceneKit calls on its render thread; overlay builds never touch it.
}
