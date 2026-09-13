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
    private func coverageGeometries(from meshAnchor: ARMeshAnchor) -> (SCNGeometry, SCNGeometry)? {
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
            anchorTransform: meshAnchor.transform
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
        return (depthGeometry, colorGeometry)
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

    /// Puts the right geometry on an anchor's node for the current mode.
    private func apply(_ meshAnchor: ARMeshAnchor, to node: SCNNode) {
        if ArkitSessionHost.shared.coverageActive,
           let pair = coverageGeometries(from: meshAnchor) {
            node.geometry = nil
            childNode(named: Self.depthNodeName, in: node, renderingOrder: -10).geometry = pair.0
            childNode(named: Self.colorNodeName, in: node, renderingOrder: 10).geometry = pair.1
        } else if let wire = makeGeometry(from: meshAnchor) {
            for child in node.childNodes { child.removeFromParentNode() }
            node.geometry = wire
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
        apply(meshAnchor, to: node)
        lastRebuild[anchor.identifier] = CACurrentMediaTime()
        return node
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        let now = CACurrentMediaTime()
        if let last = lastRebuild[anchor.identifier], now - last < Self.minRebuildInterval {
            return
        }
        lastRebuild[anchor.identifier] = now
        apply(meshAnchor, to: node)
    }

    /// Mesh anchors only report updates while ARKit is still refining them,
    /// so a surface meshed early would keep its first colour however long it
    /// was filmed afterwards. The old round-robin (6 anchors every 0.5 s)
    /// took several seconds to come back to the surface the user was looking
    /// at, which read as "it never turns yellow". Now every tick recolours the
    /// anchors nearest to the point 1.5 m in front of the camera -- what is on
    /// screen -- plus a couple of others round-robin so nothing stays stale.
    private static let coverageRefreshInterval: TimeInterval = 0.25
    private static let nearestPerRefresh = 3
    private static let roundRobinPerRefresh = 2
    private static let lookAheadMeters: Float = 1.5

    func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
        guard ArkitSessionHost.shared.coverageActive,
              time - lastCoverageRefresh >= Self.coverageRefreshInterval else { return }
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
            apply(anchor, to: node)
        }
    }

    private static func centre(of anchor: ARMeshAnchor) -> simd_float3 {
        let t = anchor.transform.columns.3
        return simd_float3(t.x, t.y, t.z)
    }

    func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
        lastRebuild.removeValue(forKey: anchor.identifier)
    }
}
